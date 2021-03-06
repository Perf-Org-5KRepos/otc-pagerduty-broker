/**
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2015, 2016. All Rights Reserved.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 */
"use strict";

var
 checkOtcApiAuth = require("./check-otc-api-auth"),
 express = require("express"),
 log4js = require("log4js"),
 nanoDocUpdater = require("nano-doc-updater"),
 nconf = require("nconf"),
 pagerdutyUtil = require("../util/pagerduty-util"),
 request = require("request"),
 tiamUtil = require("../util/tiam-util"),
 _ = require("underscore")
;

var logger = log4js.getLogger("otc-pagerduty-broker"),
 	logBasePath = "lib.middleware.service_instances";

var r = express.Router();
r
.use(checkOtcApiAuth)
.put("/:sid", createOrUpdateServiceInstance)
.put("/:sid/toolchains/:tid", bindServiceInstanceToToolchain)
.patch("/:sid", patchServiceInstance)
.delete("/:sid", deleteServiceInstance)
.delete("/:sid/toolchains", unbindServiceInstanceFromAllToolchains)
.delete("/:sid/toolchains/:tid", unbindServiceInstanceFromToolchain)
;

module.exports = r;

/**
*	Checks if the service instance already exists. If one does,
*	and the parameters need an update, then the value
*	is updated. If the parameters are not updated, a check is done to
*	update the remaining parameters, e.g. toolchains associated with
*	the service instance. Otherwise, no instance exists so
*	a PagerDuty service is created along with an instance.
*
*	Note: If a PagerDuty service is changed outside the instance, 
*   then the parameters and PagerDuty service can be out of sync.
**/
function createOrUpdateServiceInstance(req, res) {
	var logPrefix = "[" + logBasePath + ".createOrUpdateServiceInstance] ";
	var db = req.servicesDb,
		serviceInstanceId = req.params.sid,
		parametersData = req.body.parameters,
		organizationId = req.body.organization_guid,
		serviceCredentials = req.body.service_credentials;

	logger.debug(logPrefix + "Provisionning the service instance with ID: " + serviceInstanceId
			+ " using parameters:" + JSON.stringify(parametersData));
	
	// req.body (from external request) is not the same as body (response from Cloudant dB).
	if(!req.body.service_id) {
		var reason = "service_id is a required parameter";
		logger.info(logPrefix + "Returning bad request (400): " + reason);
		return res.status(400).json({ description: reason });
	}
	if(!organizationId) {
		var reason = "organization_guid is a required parameter";
		logger.info(logPrefix + "Returning bad request (400): " + reason);
		return res.status(400).json({ description: reason });
	}
	
	db.get(serviceInstanceId, null, function(err, body) {
		if(err && err.statusCode !== 404) {
			logger.error(logPrefix + "Retrieving the service instance with" +
				" ID: " + serviceInstanceId + " failed with the following" +
				" error: " + err.toString());

			res.status(500).json({ description: err.toString() });
			return;
		} else if(err && err.statusCode === 404) {
			/*
			 *	The service instance does not exist, create
			 *	one
			 **/
			if(!serviceCredentials) {
				var reason = "service_credentials is a required parameter";
				logger.info(logPrefix + "Returning bad request (400): " + reason);
				return res.status(400).json({ description: reason });
			}
			return createOrUpdateServiceInstance_(res, req, db, serviceInstanceId, organizationId, serviceCredentials, parametersData, null/*not existing body*/)
		} else {
			/*
			 *	The service instance exists but the parameters need an update.
			 **/
			if(!serviceCredentials) {
				// ensure serviceCredentials is there
				serviceCredentials = body.service_credentials;
			}
			if(!serviceCredentials) {
				var reason = "service_credentials is a required parameter";
				logger.info(logPrefix + "Returning bad request (400): " + reason);
				return res.status(400).json({ description: reason });
			}
			return createOrUpdateServiceInstance_(res, req, db, serviceInstanceId, organizationId, serviceCredentials, parametersData, null/*not existing body*/)
		}
	});
}

function createOrUpdateServiceInstance_(res, req, db, serviceInstanceId, organizationId, serviceCredentials, parametersData, body) {
	var logPrefix = "[" + logBasePath + ".createOrUpdateServiceInstance_] ";
	var site_name;
	var api_key;
	var service_name;
	var user_email;
	var user_phone;
	if (parametersData) {
		site_name = parametersData.site_name;
		
		// backward compatibility
		if (!site_name)
			site_name = parametersData.account_id;

		api_key = parametersData.api_key;
		
		// backward compatibility
		if (!api_key)
			api_key = parametersData.api_token;
		
		service_name = parametersData.service_name;
		user_email = parametersData.user_email;
		user_phone= parametersData.user_phone;
	}
	var parameters = {};
	if (site_name && api_key) {
		var baseUrl = nconf.get("services:pagerduty");
		var httpsPrefix = "https://";
		var index = baseUrl.indexOf(httpsPrefix);
		if (index != 0) {
			var reason = "Invalid pagerduty service: " + baseUrl + ", it should start with " + httpsPrefix;
			logger.info(logPrefix + "Returning bad request (400): " + reason);
			return res.status(400).json({ description: reason });
		}
		var pagerdutyDotComSuffix = baseUrl.substring(httpsPrefix.length);
		var url;
		if (site_name.indexOf(httpsPrefix) == 0 && site_name.indexOf(pagerdutyDotComSuffix) != -1) {
			// tolerate already qualified site name
			url = site_name;
		} else {
			url = httpsPrefix + site_name + '.' + pagerdutyDotComSuffix;
		}
		var apiUrl = url + "/api/v1";
		var patching = body != null;
		pagerdutyUtil.getOrCreatePagerDutyService(res, apiUrl, api_key, site_name, service_name, user_email, user_phone, patching, function(err, service, existing) {
			if (err)
				return;
			
			var dashboardUrl = url + service.service_url;
			parameters.label = service_name;
			parameters.service_id = service.id;
			parameters.service_key = service.service_key;
			
			parameters.site_name = site_name;
			parameters.api_key = api_key;
			parameters.service_name = service_name;
				
			if (existing) {
				// we're reusing an existing service, need to retrieve the user email and phone from this service
				return pagerdutyUtil.getEscalationPolicy(res, apiUrl, api_key, service.escalation_policy.id, function(err, escalationPolicy) {
					if (err)
						return;
					var userId = escalationPolicy.escalation_rules[0].targets[0].id;
					pagerdutyUtil.getUserInfo(res, apiUrl, api_key, userId, function(err, email, phone) {
						if (err)
							return;
						parameters.user_email = user_email ? user_email : email;
						parameters.user_phone = user_phone ? user_phone : phone;
						return doServiceUpdate(res, req, db, serviceInstanceId, serviceCredentials, parameters, service.id, organizationId, dashboardUrl, body);
					});
				});
			}
			parameters.user_email = user_email;
			parameters.user_phone = user_phone;
			return doServiceUpdate(res, req, db, serviceInstanceId, serviceCredentials, parameters, service.id, organizationId, dashboardUrl, body);
		});
	} else {
		// Creation of incomplete service instance
		return doServiceUpdate(res, req, db, serviceInstanceId, serviceCredentials, parameters, "n/a", organizationId, "https://www.pagerduty.com", body);
	}	
}

/**
 *	Handles updating the service instance with the new properties.
 **/
function doServiceUpdate(res, req, db, serviceInstanceId, serviceCredentials, parametersData, instanceId, organizationId, dashboardUrl, body) {
	var logPrefix = "[" + logBasePath + ".doServiceUpdate] ";
	
	// paranoia start
	if (!parametersData.site_name) {
		logger.error(logPrefix + "Site name missing");
	}
	if (!parametersData.api_key) {
		logger.error(logPrefix + "API key missing");
	}
	if (!parametersData.service_name) {
		logger.error(logPrefix + "Service name missing");
	}
	// paranoia end

	logger.debug(logPrefix + "Updating db with serviceInstanceId=" + serviceInstanceId);
	var docBody = {
		type: "service_instance",
		parameters: parametersData,
		instance_id: instanceId,
		dashboard_url: dashboardUrl,
		organization_guid: organizationId,
		service_credentials: serviceCredentials
	};
	var doc;
	if (body) {
		// patching
		doc = _.extend(body, docBody);
	} else {
		// create or update instance
		doc = _.extend(docBody, {
			toolchain_ids: []
		});
	}
	return nanoDocUpdater()
		.db(db)
		.id(serviceInstanceId)
		.existingDoc(null)
		.newDoc(doc)
		.shouldUpdate(function (published, proposed) {
			return published.type !== proposed.type ||
				   published.parameters !== proposed.parameters ||
				   published.instance_id !== proposed.instance_id ||
				   published.dashboard_url !== proposed.dashboard_url ||
				   published.organization_guid !== proposed.organization_guid;
		})
		.update(function (err) {
				if (err) {
					logger.error(logPrefix + "Updating the service instance with" +
						" ID: " + serviceInstanceId + " and parameters: " + parametersData +
						" failed with the following error: " + err.toString());

		            if(err.statusCode === 404) {
		                return res.status(404).json({ "description": err.toString() });
		            }

					return res.status(500).json({ "description": err.toString() });
				}

				return res.json({
					instance_id: instanceId,
					dashboard_url: dashboardUrl,
					parameters: parametersData,
					organization_guid: organizationId
				});
			}
		);
}

/*
	Assumption:  A service instance may only be bound to one toolchain at a time.

	If this is not the case, we should replace toolchain_id in docs with toolchain_ids
	and do a merge (adding the toolchain_id to the list) instead of clobbering the
	whole doc here.
*/
function bindServiceInstanceToToolchain(req, res/*, next*/) {
	var logPrefix = "[" + logBasePath + ".bindServiceInstanceToToolchain] ";

	var db = req.servicesDb,
	serviceInstanceId = req.params.sid,
	toolchainId = req.params.tid,
	toolchainCredentials = req.body.toolchain_credentials;
	
	var updatedDocument;
	
	logger.debug(logPrefix + "Binding the service instance with" +
			" ID: " + serviceInstanceId + " to toolchain ID: " + toolchainId);
	
	
	if (!toolchainCredentials) {
		var reason = "toolchain_credentials is a required parameter";
		logger.info(logPrefix + "Returning bad request (400): " + reason);
		return res.status(400).json({ description: reason });
	}

	return nanoDocUpdater()
	.db(db)
	.id(serviceInstanceId)
	.existingDoc(null)
	.newDoc(null)
	.shouldCreate(false)
	.shouldUpdate(function (published) {
		// only update if no binding for a given toolchain
		var result = _.find(published.toolchain_ids, function(obj) {
			if (obj.id === toolchainId) {
				return true;
			}
		});
		return result == undefined;
	})
	.merge(function (published) {
		published.toolchain_ids.push({id: toolchainId, credentials: toolchainCredentials});
		updatedDocument = published;
		return published;
	})
	.update(function (err, doc) {
		if (err) {
			logger.error(logPrefix + "Binding the service instance with" +
				" ID: " + serviceInstanceId + " to toolchain ID: " + toolchainId +
				" failed with the following error: " + err.toString());

            if(err.statusCode === 404) {
                return res.status(404).json({ "description": err.toString() });
            }

			return res.status(500).json({ "description": err });
		}

		if (!doc) {
			// no doc were updated and neither created so the document for the service was not found
			logger.error(logPrefix + "Binding the service instance with" +
				" ID: " + serviceInstanceId + " to toolchain ID: " + toolchainId +
				" failed since the service instance was not found");
            return res.status(404).json({ "description": "service instance not found" });
		}

		logger.debug(logPrefix + "Binding the service instance with" +
				" ID: " + serviceInstanceId + " to toolchain ID: " + toolchainId +
				" done");
		
		return res.status(204).json({});
	});
}

function patchServiceInstance(req, res) {
	var logPrefix = "[" + logBasePath + ".patchServiceInstance] ";
	var db = req.servicesDb;
	var sid = req.params.sid;
	var data = req.body;
	
	// only allow these properties to be updated
	var allowed = ["parameters", "service_id", "organization_guid", "user_info"];
	var notAllowedData = _.omit(data, allowed);
	var notAllowed = Object.keys(notAllowedData)
	if (notAllowed.length > 0) {
		var message = "Updating: " + notAllowed.join(", ") + " not allowed. Can only update: " + allowed.join(", ");
		logger.debug(logPrefix + message);	
		return res.status(400).json({"description": message});
	}
	// TODO: for now we're ignoring service_id and organization_guid parameters on the request, should we take them into account?
	data = _.pick(data, "parameters");
	
	var params = data.parameters;
	
	logger.debug(logPrefix + "Patching the service instance with ID: " + sid + " using parameters:" + JSON.stringify(params));	
	
	// only allow these properties in parameters to be updated
	var allowedParams = ["site_name", "api_key", "service_name", "user_email", "user_phone"];
	var notAllowedParams = _.omit(params, allowedParams);
	if (Object.keys(notAllowedParams).length > 0) {
		return res.status(400).json({"description": "Can only update these parameters properties: " + allowedParams.join(", ")});
	}
	params = _.pick(params, "site_name", "api_key", "service_name", "user_email", "user_phone");
	
	// validate properties to be udated
	if (Object.keys(params).length == 0) {
		var reason = "No service instance properties to update";
		logger.info(logPrefix + "Returning bad request (400): " + reason);
		return res.status(400).json({ description: reason });
	}

	db.get(sid, null, function(err, body) {
		if (err) {
			logger.error(logPrefix + "Retrieving the service instance with"
				+ " ID: " + sid+ " failed with the following"
				+ " error: " + err.toString());
			return res.status(404).json({"description": "Service instance " + sid + " not found"});
		} else if (!body.organization_guid) {
			logger.warn(logPrefix + "The service instance with ID " +
					serviceInstanceId + " does not have an organization_guid defined.");
		}
        var organizationId;
        if (req.body.organization_guid) {
        	// New organization
        	organizationId =req.body.organization_guid; 
        } else {
        	organizationId= body.organization_guid
        }
        var serviceCredentials = body.service_credentials;
		var existingParams = body.parameters;
		if (!params.site_name)
			params.site_name = existingParams.site_name;
		
		// backward compatibility
		if (!params.site_name)
			params.site_name = existingParams.account_id;
		
		if (!params.api_key)
			params.api_key = existingParams.api_key;
		if (!params.service_name)
			params.service_name = existingParams.service_name;
		if (!params.user_email)
			params.user_email = existingParams.user_email;
		if (!params.user_phone)
			params.user_phone = existingParams.user_phone;
		return createOrUpdateServiceInstance_(res, req, db, sid, organizationId, serviceCredentials, params, body);
	});
}

/**
 * Delete the service instance.
 * Note this leaves the PagerDuty service behind.
 **/
function deleteServiceInstance(req, res) {
	var logPrefix = "[" + logBasePath + ".deleteServiceInstance] ";
	var db = req.servicesDb,
	serviceInstanceId = req.params.sid;

	logger.debug(logPrefix + "Delete the service instance with" +
			" ID: " + serviceInstanceId);
	
	/**
	*	Find out the id of the service to remove.
	**/
	db.get(serviceInstanceId, null, function(err, body) {
		/**
		*	An error occurred during the request, or the service
		*	instance does not exist.
		**/
		if(err) {
			logger.error(logPrefix + "Retrieving the service instance with" +
				" ID: " + serviceInstanceId + " failed with the following" +
				" error: " + err.toString());

            if(err.statusCode === 404) {
                return res.status(404).json({ "description": err.toString() });
            }
			res.status(500).json({ "description": err.toString() });
			return;
		} else {
			request.del({
				uri: body.dashboard_url
			}, function(err, reqRes, body) {
				if(err) {
					logger.error(logPrefix + "Unbinding the service instance with" +
						" ID: " + serviceInstanceId + " failed with the following" +
						" error: " + err.toString());

					res.status(500).json({ "description": err.toString() });
					return;
				}

				return nanoDocUpdater()
					.db(db)
					.id(serviceInstanceId)
					.existingDoc(null)
					.shouldCreate(false)
					.shouldUpdate(function (published) {
						return (!published._deleted);
					})
					.merge(function (published) {
						return _.extend({ _deleted: true }, published);
					})
					.update(function (err) {
						if (err) {
							logger.error(logPrefix + "Removing the service instance with ID: " +
								serviceInstanceId + " failed with the following error: " + err.toString());
							
				            if(err.statusCode === 404) {
				                return res.status(404).json({ "description": err.toString() });
				            }
	
							return res.status(500).json({ "description": "Could not delete service instance: " + err.toString() });
						}
	
						return res.status(204).json({});
					});
			});
		}
	});
}

/**
 * Unbind the service instance from the toolchain.
 */
function unbindServiceInstanceFromToolchain(req, res) {
	var logPrefix = "[" + logBasePath + ".unbindServiceInstanceFromToolchain] ";
	var db = req.servicesDb,
	serviceInstanceId = req.params.sid,
	toolchainId = req.params.tid;

	logger.debug(logPrefix + "Unbinding the service instance with" +
			" ID: " + serviceInstanceId + " from toolchain ID: " + toolchainId);
	
	return nanoDocUpdater()
	.db(db)
	.id(serviceInstanceId)
	.existingDoc(null)
	.newDoc(null)
	.shouldCreate(false)
	.shouldUpdate(function (published) {
		var result = _.find(published.toolchain_ids, function(obj) {
			if (obj.id === toolchainId) {
				return true;
			}
		});
		return result !== undefined;
	})
	.merge(function (published) {
		published.toolchain_ids = _.reject(published.toolchain_ids, function(obj) {
			if (obj.id === toolchainId) {
				return true;
			}
		});
		return published;
	})
	.update(function (err, doc) {
		if (err) {
			logger.error(logPrefix + "Unbinding the service instance with" +
				" ID: " + serviceInstanceId + " from toolchain ID: " + toolchainId +
				" failed with the following error: " + err.toString());

            if(err.statusCode === 404) {
                return res.status(404).json({ "description": err.toString() });
            }

			return res.status(500).json({ "description": "Could not unbind service instance: " + err.toString() });
		}

		if (!doc) {
			logger.error(logPrefix + "Unbinding the service instance with" +
				" ID: " + serviceInstanceId + " from toolchain ID: " + toolchainId +
				" failed since the service instance was not found");

			// no doc were updated and neither created so the document for the service was not found
            return res.status(404).json({ "description": "service instance not found" });
		}

		return res.status(204).json({});
	});
}

/**
 * Unbind the service instance from all toolchains.
 */
function unbindServiceInstanceFromAllToolchains(req, res) {
	var logPrefix = "[" + logBasePath + ".unbindServiceInstanceFromAllToolchains] ";
	var db = req.servicesDb,
	serviceInstanceId = req.params.sid;

	logger.debug(logPrefix + "Unbinding the service instance with" +
			" ID: " + serviceInstanceId + " from all toolchains");
	
	return nanoDocUpdater()
	.db(db)
	.id(serviceInstanceId)
	.existingDoc(null)
	.newDoc(null)
	.shouldCreate(false)
	.shouldUpdate(function (published) {
		return published.toolchain_ids.length > 0;
	})
	.merge(function (published) {
		published.toolchain_ids = [];
		return published;
	})
	.update(function (err, doc) {
		if (err) {
			logger.error(logPrefix + "Unbinding the service instance with" +
				" ID: " + serviceInstanceId + " from all toolchains" +
				" failed with the following error: " + err.toString());

            if(err.statusCode === 404) {
                return res.status(404).json({ "description": err.toString() });
            }

			return res.status(500).json({ "description": "Could not unbind service instance: " + err.toString() });
		}

		if (!doc) {
			logger.error(logPrefix + "Unbinding the service instance with" +
				" ID: " + serviceInstanceId + " from all toolchains" +
				" failed since the service instance was not found");

			// no doc were updated and neither created so the document for the service was not found
            return res.status(404).json({ "description": "service instance not found" });
		}
		
		res.status(204).json({});
	});
}
