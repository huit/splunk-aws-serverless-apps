/**
 * Splunk-enabled logging function
 *
 * This function logs to a Splunk host using Splunk's event collector
 * API. API calls are authenticated using a long-lived event collector
 * token.
 *
 * Follow these steps to configure the function to log to your Splunk
 * host:
 *
 * 1. Insert your host and port in the splunkHost field. Default port
 * for the event collector is 8088. Make sure no firewalls will prevent
 * your Lambda function from connecting to this port on your host.
 *
 * 2. Create an event collector token for you function to use -
 * http://docs.splunk.com/Documentation/Splunk/6.3.0/Data/UsetheHTTPEventCollector#Create_an_Event_Collector_token
 *
 * 3. Create a KMS key - http://docs.aws.amazon.com/kms/latest/developerguide/create-keys.html
 *
 * 4. Encrypt the event collector token using the AWS CLI
 *      aws kms encrypt --key-id alias/<your KMS key name> --plaintext "<splunk event collector token>"
 *
 * 5. Copy the base-64 encoded, encrypted token from step 4's CLI output
 * (CiphertextBlob attribute) to the base64EncodedEncryptedToken field on
 * the loggerInfo object in the "// User code" section in this file
 *
 * 6. Give your function's role permission for the kms:Decrypt action.
 * Example:

{
    "Version": "2012-10-17",
    "Statement": [
    {
        "Sid": "Stmt1443036478000",
        "Effect": "Allow",
        "Action": [
            "kms:Decrypt"
            ],
        "Resource": [
            "<your KMS key ARN>"
            ]
    }
    ]
}

 */
// Library code
var url = require('url');
var AWS = require('aws-sdk');

var initSplunkTokenAsync = function(loggerInfo) {
    var encryptedTokenBuf = new Buffer(loggerInfo.base64EncodedEncryptedToken, 'base64');
    var kms = new AWS.KMS();
    var params = {
        CiphertextBlob: encryptedTokenBuf
    };
    kms.decrypt(params, function(err, data) {
        if (err) {
            loggerInfo.tokenInitError = err;
            console.log(err);
        } else {
            loggerInfo.decryptedToken = data.Plaintext.toString('ascii');
        }
    });
};

var Logger = function(context) {
    var payloads = [];
    
    function log() {
        var time = Date.now();
        var args = [time].concat(Array.prototype.slice.call(arguments));
        logWithTime.apply(args);
    }
    
    function logWithTime() {
        var args = Array.prototype.slice.call(arguments);
        var payload = {};
        var event = {};
        if (args[1] !== null && typeof args[1] === 'object') {
            event.message = args[1];
        } else {
            event.message = args.slice(1).join(' ');
        }

        if (typeof context !== 'undefined') {
            var reqId = context.awsRequestId;
            if (typeof reqId !== 'undefined') {
                event.awsRequestId = context.awsRequestId;
            }
            payload.source = context.functionName;
        }

        payload.time = new Date(args[0]).getTime() / 1000;
        payload.event = event;
        logEvent(payload);
    }

    function logEvent(payload) {
        payloads.push(JSON.stringify(payload));
    }

    function flushAsync(callback) {
        // Check if we retrieved the decrypted token from KMS yet
        if (!loggerInfo.decryptedToken) {
            if (loggerInfo.tokenInitError) {
                console.log('Cannot flush logs since there was an error fetching the token for Splunk. Not retrying.');
                return;
            }
            console.log('Cannot flush logs since authentication token has not been initialized yet. Trying again in 100 ms.');
            setTimeout(function() { flushAsync(callback); }, 100);
            return;
        }
        var parsed = url.parse(loggerInfo.splunkHost);
        var options = {
            hostname: parsed.hostname,
            path: parsed.path,
            port: parsed.port,
            method: 'POST',
            headers: {
                'Authorization': "Splunk " + loggerInfo.decryptedToken
            },
            rejectUnauthorized: false,
        };
        var requester = require(parsed.protocol.substring(0, parsed.protocol.length - 1));
        console.log('Sending event');
        var req = requester.request(options, function(res) {
            res.setEncoding('utf8');

            console.log('Response received');
            res.on('data', function(data) {
                if (res.statusCode != 200) {
                    throw new Error("error: statusCode=" + res.statusCode + "\n\n" + data);
                }
                payloads.length = 0;
                console.log('Sent');
                if (typeof callback !== 'undefined') {
                    callback();
                }
            });
        });

        req.end(payloads.join(''), 'utf8');
    }

    return {
        log: log,
        logEvent: logEvent,
        logWithTime: logWithTime,
        flushAsync: flushAsync
    };
};


// User code

var loggerInfo = {
    splunkHost: 'https://<splunk host:port>/services/collector', // Fill in with your Splunk host IP/DNS and port (step 1 above)
    base64EncodedEncryptedToken: '', // Fill in with base64-encoded, encrypted Splunk token here (step 5 above)
    lambdaFunctionName: ''  // Fill in with your function name
};

initSplunkTokenAsync(loggerInfo);

var glogger = new Logger({ functionName: loggerInfo.lambdaFunctionName });
glogger.log('Loading function');
glogger.flushAsync();

exports.handler = function(event, context) {
    var logger = new Logger(context);
    
    //log strings
    logger.log('value1 =', event.key1);
    logger.log('value2 =', event.key2);
    logger.log('value3 =', event.key3);
    
    //log JSON objects
    logger.log(event);
    
    //specify the timestamp explicitly, useful for forwarding events like from AWS IOT
    logger.logWithTime(Date.now(), event);

    //send all the events in a single batch to Splunk
    logger.flushAsync(function() {
        context.succeed(event.key1);  // Echo back the first key value
    });
};