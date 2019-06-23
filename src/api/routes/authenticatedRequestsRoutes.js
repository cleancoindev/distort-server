"use strict";
module.exports = function(app) {
  var distort = require('../controllers/authenticatedRequestsController');

  // Manage group membership
  app.route('/groups')
    .get(distort.listGroups)
    .post(distort.addGroup);

  // Manage activity within a group
  app.route('/groups/:groupName')
    .get(distort.fetchConversations)
    .put(distort.postMessage)
    .delete(distort.leaveGroup);

  // Fetch messages from a group in given range
  app.route('/groups/:groupName/:indexStart/:indexEnd')
    .get(distort.readConversationMessagesInRange);
  app.route('/groups/:groupName/:indexStart')
    .get(distort.readConversationMessagesInRange);

  // Manage accounts
  app.route('/account')
    .get(distort.fetchAccount)
    .put(distort.updateAccount)
    .delete(distort.deleteAccount);

  // Manage peers
  app.route('/peers')
    .get(distort.fetchPeers)
    .post(distort.addPeer)
    .delete(distort.removePeer);

  app.route('/social-media')
    .get(distort.getDistortIdentity)
    .put(distort.setIdentity);

  // TODO: Manage queue
  /*app.route('/queue')
    .get(distort.fetchQueue)
    .delete(distort.cancelMessage);*/

  app.route('/signatures')
    .get(distort.signText)
    .post(distort.verifySignature);
};
