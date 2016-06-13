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
 async = require("async"),
 bodyParser = require("body-parser"),
 express = require("express"),
 https = require('https'),
 HttpsAgent = require("agentkeepalive").HttpsAgent,
 log4js = require("log4js"),
 nano = require("nano"),
 nanoDocUpdater = require("nano-doc-updater"),
 nconf = require("nconf"),
 path = require("path"),
 url = require("url"),
 util = require("util"),
 _ = require("underscore")
;

// Swagger (temporary until within pipeline stage/job)
var swaggerUiMiddleware = require("swagger-ui-middleware"),
otcPagerDutyBrokerSwaggerSpecFile = path.join(__dirname, "/spec", "otc-pagerduty-broker-swagger-spec.json"),
otcPagerDutyBrokerSwaggerSpec = require(otcPagerDutyBrokerSwaggerSpecFile);

var logger = log4js.getLogger("otc-pagerduty-broker"),
 	logBasePath = "index";

/* 
 * Method used to configure all the middleware before starting the server.
 */
exports.configureMiddleware = function(externalCallback) {
	async.auto({
	    validateOptions: function (callback) {
	    	validateConfSync();
	        callback();
	    },
	    createDb: [ "validateOptions", function (callback) {
	        createDb(callback);
	    }],
	    initializeDb: [ "createDb", function (callback, r) {
	    	initOrUpdateDesign(r.createDb, callback);
	    }],
	    configureApp: ["initializeDb", function(callback, r) {
			configureAppSync(r.initializeDb);
			callback();
	    }]
	}, function (err/*, r*/) {
	    if (err) {
	        util.log("An error occurred during setup: " + err.toString());
	        process.exit(1);
	    }
	    externalCallback(err);
	});
}

/*
 * Export app so that servers can be listened to from it.
*/
var app = express();
exports.server = app;

// Enable connection pooling
https.globalAgent.keepAlive = true;

function validateConfSync() {
	
    // Verify that a list of keys this app expects are defined.
    var requiredKeys = [
        "PORT",
        "url",
        "TIAM_URL",
        "TIAM_CLIENT_ID",
        "OTC_API_BROKER_SECRET",
        "services:pagerduty",
        "services:otc_api",
        "services:otc_ui",
        "services:ibm_snip_api"
    ];

    var missingRequiredKeys = _.reject(requiredKeys, function (key) {
        return nconf.get(key);
    });

    if (missingRequiredKeys.length > 0) {
        util.log("ERROR: The following required configuration fields are missing:");
        util.log(missingRequiredKeys.join(", "));
        util.log("ERROR: ...these can be overridden using the following envvars:");
        util.log(missingRequiredKeys.map(function (k) {
            return k.replace(/:/g, "__");
        }).join(", "));
		process.exit(1);
    }	
	
	/* Make sure that important bits of VCAP_SERVICES are defined. */
	if (!nconf.get("_vcap_services:cloudantNoSQLDB:0:credentials:url")) {
		util.log(
			"Could not figure out the database server url. Either run this on Bluemix or point a config file containing at least the following: \n\n" +
			JSON.stringify({ _vcap_services: { cloudantNoSQLDB: [ { credentials: { url: "https://url" } } ] } })
		);
		process.exit(1);
	}
}

function configureAppSync(db) {
	var logPrefix = "[" + logBasePath + ".configureAppSync] ";
	
	var instanceUrl = url.parse(nconf.get("url"));
	var scheme = instanceUrl.protocol.substring(0, instanceUrl.protocol.length - 1);

	app
	// If a request comes in that appears to be http, reject it.
	.use(function (req, res, next) {
	  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
	    return res.status(403).send('https required');
	  }
	  next();
	})
	
	.use(log4js.connectLogger(log4js.getLogger("request"), {
	    format: ":method :url :status - :response-time ms"
	}))
	
	.use(bodyParser.json())
	.get("/status", function (req, res/*, next*/) {
        return res.status(200).send("The PagerDuty Broker is running.");
    })
	
	.get("/version", function (req, res/*, next*/) {
        return res.status(200).send({build: process.env.BUILD_NUMBER});
    })
    
    .use("/swagger", swaggerUiMiddleware(
        _.extend(otcPagerDutyBrokerSwaggerSpec, {
        	"host": instanceUrl.host
        }, {
        	"schemes": [scheme]
        })
    ))
    
	// Tack a handle to the Services Database to every request for use in the middleware.
	.use(function (req, res, next) {
		req.servicesDb = db;
		next();
	})

	// OTC lifecycle operations (i.e. provision, bind, unprovision, unbind)
	.use("/pagerduty-broker/api/v1/service_instances", require("./lib/middleware/service_instances"))

	// Endpoint for the lifecycle messaging store and toolchain api lifecycle events
	.use("/pagerduty-broker/api/v1/messaging", require("./lib/event/event"))

	// Handle errors
	.use(function(error, req, res, next) {
		if (error) {
			logger.debug(logPrefix + "The application request failed with the following error: " + error.toString());

			res.status(400).send(JSON.stringify(error, null, 3));
		}
		else {
			return next();
		}
	})
	.use(function (req, res, next) {
		return res.status(400).json({description: "Route does not exist."});
	})
	;
}

function createDb(callback) {
	var logPrefix = "[" + logBasePath + ".createDb] ";
	var DB_NAME = "pagerduty_broker";
	var keepAliveAgent = new HttpsAgent({
		maxSockets: 50,
		maxKeepAliveRequests: 0,
		maxKeepAliveTime: 30000
	});
	var nanoObj = nano(
		nconf.get("_vcap_services:cloudantNoSQLDB:0:credentials:url"),
		{ requestDefaults: { agent: keepAliveAgent } }
	);

	nanoObj.db.create(DB_NAME, function (err/*, r*/) {
		if (err && err.error !== "file_exists") {
			logger.error(logPrefix + "Creating the database failed with the following error: " + err.toString());

			return callback("Could not create db: " + err.toString());
		}
		
		callback(null, nanoObj.use(DB_NAME));
	});
}

function initOrUpdateDesign(db, callback) {
	var DESIGN_DOC_NAME = "_design/pagerduty";

	/* global emit */
	var DESIGN_DOC = {
		language: "javascript",
		version: 1,
		views: {
			service_instances: {
				map: function (doc) {
					if (doc.type === "service_instance") {
						emit(doc.id, doc);
					}
				}
			}
		}
	};

	return nanoDocUpdater()
	.db(db)
	.existingDoc(null)
	.newDoc(DESIGN_DOC)
	.id(DESIGN_DOC_NAME)
	.shouldUpdate(function (existing, newVer) {
		return !existing.version || existing.version < newVer.version;
	})
	.merge(null)
	.update(function(err) {
		callback(err, db);
	});
}