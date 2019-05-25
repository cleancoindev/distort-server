"use strict";
var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var InMessageSchema = new Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversations',
    required: 'Must reference the existing conversation message was received on'
  },
  dateReceived: {
    type: Date,
    default: Date.now
  },
  index: {
    type: Number,
    required: 'Must specify message index within group'
  },
  message: {
    type: String,
    required: 'Cannot save empty messages'
  },
  verified: {
    type: Boolean,
    default: false
  }
});

// For each conversation, their may only be a single message with any given index
InMessageSchema.index({conversation: 1, index: 1}, {unique: true});

module.exports = mongoose.model('InMessages', InMessageSchema)
