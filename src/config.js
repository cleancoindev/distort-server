"use strict";

var fs = require('fs');

// Load configuration
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Export known parameters
exports.debug = config.debug;
exports.defaultGroup = config.defaultGroup;
exports.ipfsNode = config.ipfsNode;
exports.manualRootPassword = config.manualRootPassword;
exports.maxRead = config.maxRead;
exports.mongoAddress = config.mongoAddress;
exports.port = config.port;
exports.protocolVersion = config.protocolVersion;
exports.socialMedia = config.socialMedia;
