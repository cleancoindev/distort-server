"use strict";
var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var OutMessageSchema = new Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversations',
    required: 'Must reference the existing conversation message was sent on'
  },
  index: {
    type: Number,
    unique: true,
    required: 'Must specify message index within group'
  },
  lastStatusChange: {
    type: Date,
    default: Date.now
  },
  message: {
    type: String,
    required: 'Cannot save empty messages'
  },
  status: {
    type: String,
    enum: ['enqueued', 'cancelled', 'sent'],
    default: 'enqueued'
  },
  to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Certs',
    required: 'Cannot save message without target (certificate)'
  }
});

module.exports = mongoose.model('OutMessages', OutMessageSchema)
