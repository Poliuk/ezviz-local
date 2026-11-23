'use strict';

// ezviz-local: control an EZVIZ camera on your own network, with no cloud.
//
//   control()      one authenticated command-port frame (login, send, ack)
//   ptzFrameTail() the body of a pan/tilt command
//   PTZ            pan/tilt command id and direction codes
//   move()         start, wait, stop, with the stop always attempted
//   probe()        read-only check of the command port and RTSP service
//   EzvizLanError  every error this package throws; see err.code
//   cloud          the one cloud exception: toggle device feature switches
//                  (privacy, status LED, sleep, IR) that the camera does not
//                  expose locally. See lib/cloud.js; it needs the EZVIZ account.

const { control, ptzFrameTail, PTZ, EzvizLanError } = require('./control');
const { move } = require('./move');
const { probe } = require('./probe');
const cloud = require('./cloud');

module.exports = { control, ptzFrameTail, PTZ, EzvizLanError, move, probe, cloud };
