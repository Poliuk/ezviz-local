'use strict';

// ezviz-local: control an EZVIZ camera on your own network, with no cloud.
//
//   control()      one authenticated command-port frame (login, send, ack)
//   ptzFrameTail() the body of a pan/tilt command
//   PTZ            pan/tilt command id and direction codes
//   move()         start, wait, stop, with the stop always attempted
//   probe()        read-only check of the command port and RTSP service
//   EzvizLanError  every error this package throws; see err.code

const { control, ptzFrameTail, PTZ, EzvizLanError } = require('./control');
const { move } = require('./move');
const { probe } = require('./probe');

module.exports = { control, ptzFrameTail, PTZ, EzvizLanError, move, probe };
