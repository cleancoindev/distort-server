"use strict";

var mongoose = require('mongoose'),
  sjcl = require('../../sjcl'),
  distort_ipfs = require('../../distort-ipfs'),
  groupTree = require('../../groupTree'),
  config = require('../../config'),
  utils = require('../../utils'),
  Account = mongoose.model('Accounts'),
  Cert = mongoose.model('Certs'),
  Conversation = mongoose.model('Conversations'),
  Group = mongoose.model('Groups'),
  InMessage = mongoose.model('InMessages'),
  OutMessage = mongoose.model('OutMessages'),
  Peer = mongoose.model('Peers');

const debugPrint = utils.debugPrint;
const sendErrorJSON = utils.sendErrorJSON;
const sendMessageJSON = utils.sendMessageJSON;
const formatPeerString = utils.formatPeerString;
const PARANOIA = utils.PARANOIA;
const secp256k1 = utils.secp256k1;

// Ensure the correct active Group-ID in DB
function updateActiveGroup(peerId, groupId, accountName) {
  Account.findOne({'peerId': peerId, 'accountName': accountName || 'root'}, function(err, account) {
    if(err) {
      throw err;
    }

    if(account.activeGroup != groupId) {
      account.activeGroup = groupId;
      account.save();
    }
  });
}
// Remove all conversations (and their respective messages) that match given filter
function removeMatchingConversations(filter) {
  return new Promise((resolve, reject) => {
    Conversation.find(filter, function(err, conversations) {
      for(var i = 0; i < conversations.length; i++) {
        InMessage.find({conversation: conversations[i]._id}, (err, ins) => {
          if(err) {
            return reject(err);
          }
          for(var j = 0; j < ins.length; j++) {
            ins[j].remove();
          }

          OutMessage.find({conversation: conversations[i]._id}, (err, outs) => {
            if(err) {
              return reject(err);
            }
            for(var j = 0; j < outs.length; j++) {
              outs[j].remove();
            }

            conversations[i].remove();
            resolve(true);
          });
        });
      }
    });
  });
}


// List all (sub)group memberships through their groups and subgroup paths
exports.listGroups = function(req, res) {
  Group.aggregate(
  [{
    $lookup: {
      from: 'accounts',
      localField: 'owner',
      foreignField: '_id',
      as: 'owner'
    }
  },
  {
    $unwind: '$owner'
  },
  {
    $match: {
      'owner.peerId': req.headers.peerid,
      'owner.accountName': req.headers.accountname
    }
  }]).exec(function(err, groups) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    // Pointless to reinform of self as owner
    for(var i = 0; i < groups.length; i++) {
      delete groups[i]['owner'];
      delete groups[i]['__v'];
      delete groups[i]['_id'];
    }

    res.json(groups);
  });
};

// Add topic and given subgroup path to account's groups
exports.addGroup = function(req, res) {
  const subLevel = parseInt(req.body.subgroupLevel);
  if(isNaN(subLevel) || subLevel < 0 || subLevel > groupTree.MAX_PATH_DEPTH) {
    return sendErrorJSON(res, 'Field "subgroupLevel" must be a non-negative integer', 400);
  }
  const groupName = req.body.name;
  if(!groupName || typeof groupName !== "string") {
    return sendErrorJSON(res, 'Field "name" must be a non-empty string', 400);
  }
  const subI = groupTree.randomFromLevel(subLevel);

  Account.findOne({peerId: req.headers.peerid, accountName: req.headers.accountname}, function(err, account) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    var reqGroup = {};
    reqGroup.name = groupName;
    reqGroup.owner = account._id;
    Group.findOne(reqGroup, function(err, group) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }

      // If authenticating account already belongs to group, update
      if(group) {
        if(group.subgroupIndex == subI) {
          // no changes made to group
          return res.json(group);
        }

        // New group-tree node. Subscribe to new node then unsubscribe old
        // (that way the *-cert channel isn't unsubscribed then re-added)
        const oldIndex = group.subgroupIndex;
        return distort_ipfs.subscribe(group.name, subI).then(() => {
          return distort_ipfs.unsubscribe(group.name, oldIndex);
        }).then(() => {
          group.subgroupIndex = subI;
          group.save(function(err) {
            if(err) {
              return sendErrorJSON(res, err, 500);
            }

            // Include updated group in certificate
            Cert.findById(account.cert, function(err, cert) {
              if(err) {
                return sendErrorJSON(res, err, 500);
              }

              // Replace old group index with new one in account certificate
              const newG = [group.name + ":" + subI];
              const couple = group.name + ":" + oldIndex;
              for(var i = 0; i < cert.groups.length; i++) {
                if(cert.groups[i] !== couple) {
                  newG.push(cert.groups[i]);
                }
              }
              cert.groups = newG;

              cert.save(function(err) {
                if(err) {
                  return sendErrorJSON(res, err, 500);
                }

                group = group.toObject();
                delete group['owner'];
                delete group['_id'];
                delete group['__v'];

                // Succeeded all the trials, group is fully updated
                return res.json(group);
              });
            });
          });
        }).catch(err => {
          return sendErrorJSON(res, err, 500);
        });
      } else {
        reqGroup.subgroupIndex = subI;
        try {
          distort_ipfs.subscribe(groupName, subI);
        } catch(err) {
          return sendErrorJSON(res, err, 500);
        }

        var newGroup = new Group(reqGroup);
        newGroup.save(function(err, group) {
          if(err) {
            return sendErrorJSON(res, err, 500);
          }

          // If none active, set new group to be active group
          if(!account.activeGroup) {
            try {
              updateActiveGroup(req.headers.peerid, group._id, req.headers.accountname);
            } catch(err) {
              return sendErrorJSON(res, err, 500);
            }
          }

          // Include group in certificate
          Cert.findById(account.cert, function(err, cert) {
            if(err) {
              return sendErrorJSON(res, err, 500);
            }
            cert.groups.push(group.name + ":" + group.subgroupIndex);
            cert.save(function(err) {
              if(err) {
                return sendErrorJSON(res, err, 500);
              }

              group = group.toObject();
              delete group['__v'];
              delete group['_id'];
              delete group['owner']

              // Succeeded all the trials, group is fully added
              res.json(group);
            });
          });
        });
      }
    });
  });
};


// List all (sub)group memberships through their groups and subgroup paths
exports.fetchConversations = function(req, res) {
  Conversation.aggregate([
  {
    $lookup: {
      from: 'accounts',
      localField: 'owner',
      foreignField: '_id',
      as: 'owner'
    }
  },
  {
    $lookup: {
      from: 'groups',
      localField: 'group',
      foreignField: '_id',
      as: 'group'
    }
  },
  {
    $unwind: '$owner'
  },
  {
    $unwind: '$group'
  },
  {
    $match: {
      'owner.peerId': req.headers.peerid,
      'owner.accountName': req.headers.accountname,
      'group.name': req.params.groupName
    }
  }]).exec(function(err, conversations) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    for(var i = 0; i < conversations.length; i++) {
      delete conversations[i]['_id'];
      delete conversations[i]['__v'];
      delete conversations[i]['owner'];
      conversations[i].group = conversations[i].group.name;
    }

    res.json(conversations);
  });
};

// Enqueue a message to the specified group
exports.postMessage = function(req, res) {
  Group.aggregate(
  [{
    $lookup: {
      from: 'accounts',
      localField: 'owner',
      foreignField: '_id',
      as: 'owner'
    }
  },
  {
    $unwind: '$owner'
  },
  {
    $match: {
      'name': req.params.groupName,
      'owner.peerId': req.headers.peerid,
      'owner.accountName': req.headers.accountname
    }
  }]).exec(function(err, group) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    group = group[0];
    if(!group) {
      return sendErrorJSON(res, 'Account is not a member of group: ' + req.params.groupName, 404);
    }

    // Must include one way to identify peer
    if(!req.body.toPeerId && !req.body.toNickname) {
      return sendErrorJSON(res, 'Must include "toPeerId" or "toNickname" in request body', 400);
    }

    // Must include a non-empty message
    if(!req.body.message || typeof req.body.message !== "string") {
      return sendErrorJSON(res, 'Must include a non-empty string "message" in request body', 400);
    }

    // Determine if we have the certificate of the intended peer
    var certPromise = new Promise(function(resolve, reject) {
      // Can specify peer by friendly nickname or explicit peer-ID
      if(req.body.toPeerId) {
        Cert.findOne({accountName: req.body.toAccountName || 'root', peerId: req.body.toPeerId, status: 'valid'}, function(err, cert) {
          if(err) {
            return reject({msg: err, code: 500});
          }

          if(!cert) {
            reject({
              msg: 'Could not find cert for given peer-ID. Please wait for their periodically posted certificate',
              code: 404
            });
          } else {
            resolve(cert);
          }
        });
      } else {
        Peer
          .findOne({owner: group.owner._id, nickname: req.body.toNickname})
          .populate('cert')
          .exec(function(err, peer) {
          if(err) {
            return reject({msg: err, code: 500});
          }

          if(!peer) {
            reject({
              msg: 'Could not find cert for given nickname. Please wait for their periodically posted certificate',
              code: 404
            });
          } else {
            resolve(peer.cert);
          }
        });
      }
    }).then(function(toCert) {
      // If posting to this account and group soon, assume it to be the active group
      try {
        updateActiveGroup(req.headers.peerid, group._id, req.headers.accountname);
      } catch(err) {
        return reject({msg: err, code: 500});
      }

      // Must get conversation this message belongs to, or create a new one
      new Promise(function (resolve, reject) {
        Conversation.findOne({group: group._id, peerId: toCert.peerId, accountName: toCert.accountName}, function(err, conversation) {
          if(err) {
            return reject({msg: err, code: 500});
          }
          if(conversation) {
            return resolve(conversation);
          } else {
            Account.findOne({peerId: req.headers.peerid, accountName: req.headers.accountname}, function(err, account) {
              if(err) {
                return reject({msg: err, code: 500});
              }
              const newConversation = new Conversation({
                group: group._id,
                owner: account._id,
                peerId: toCert.peerId,
                accountName: toCert.accountName
              });
              newConversation.save(function(err, conversation) {
                if(err) {
                  return reject({msg: err, code: 500});
                }
                return resolve(conversation);
              });
            });
          }
        });
      }).then(function(conversation) {
        var outMessage = new OutMessage({
          conversation: conversation._id,
          index: conversation.height++,
          message: req.body.message,
          to: toCert._id
        });
        outMessage.save(function(err, msg) {
          if(err) {
            return reject({msg: err, code: 500});
          }

          debugPrint('Saved enqueued message to DB at index: ' + msg.index);

          conversation.latestStatusChangeDate = Date.now();
          conversation.save(function(err) {
            if(err) {
              return reject({msg: err, code: 500});
            }

            msg = msg.toObject();            delete msg['_id'];
            delete msg['__v'];
            delete msg['conversation'];
            delete msg['to'];

            // Only send success after all transactions succeed
            res.json(msg);
          });
        });
      });
    }).catch(function(err) {
      return sendErrorJSON(res, err.msg, err.code);
    });
  });
};

// Stop streaming on the specified group
exports.leaveGroup = function(req, res) {
  Group.aggregate(
  [{
      $lookup: {
      from: 'accounts',
      localField: 'owner',
      foreignField: '_id',
      as: 'owner'
    }
  },
  {
    $unwind: '$owner'
  },
  {
    $match: {
      'name': req.params.groupName,
      'owner.peerId': req.headers.peerid,
      'owner.accountName': req.headers.accountname
    }
  }]).exec(function(err, group) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    group = group[0];
    if(!group) {
      return sendErrorJSON(res, 'Account is not a member of group: ' + req.params.groupName, 404);
    }

    Group.findByIdAndRemove(group._id, function(err, delStats) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }

      // Remove all conversations associated with group
      removeMatchingConversations({group: group._id});

      try {
        distort_ipfs.unsubscribe(group.name, group.subgroupIndex);
      } catch(err) {
        console.log(err);
      }

      // Remove group from certificate
      Account
        .findOne({peerId: req.headers.peerid, accountName: req.headers.accountname})
        .exec(function(err, acct) {
        if(err) {
          return sendErrorJSON(res, err, 500);
        }

        if(String(acct.activeGroup) === String(group._id)) {
          acct.activeGroup = undefined;
          acct.save();
        }

        Cert.findById(acct.cert, function(err, cert) {
          if(err) {
            return sendErrorJSON(res, err, 500);
          }

          const couple = group.name + ":" + group.subgroupIndex;
          for(var i = cert.groups.length-1; i >= 0; i--) {
            if(couple === cert.groups[i]) {
              cert.groups.splice(i, 1);
            }
          }
          cert.save(function(err) {
            if(err) {
              return sendErrorJSON(res, err, 500);
            }

            sendMessageJSON(res, 'Successfully left group: ' + req.params.groupName);
          });
        });
      })
    });
  });
};


// Retrieve messages for the specified group
exports.readConversationMessagesInRange = function(req, res) {
  Group.aggregate(
  [{
      $lookup: {
      from: 'accounts',
      localField: 'owner',
      foreignField: '_id',
      as: 'owner'
    }
  },
  {
    $unwind: '$owner'
  },
  {
    $match: {
      'name': req.params.groupName,
      'owner.peerId': req.headers.peerid,
      'owner.accountName': req.headers.accountname
    }
  }]).exec(function(err, group) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    group = group[0];
    if(!group) {
      return sendErrorJSON(res, 'Account is not a member of group: ' + req.params.groupName, 404);
    }

    Conversation.findOne({group: group._id, peerId: req.query.peerId, accountName: req.query.accountName || 'root'}, function(err, conversation) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }
      if(!conversation) {
        // Group exists but there have been no messages between peers
        return res.json({'in': [], 'out': []});
      }

      const indexStart = parseInt(req.params.indexStart);
      const indexEnd = req.params.indexEnd ? parseInt(req.params.indexEnd) : conversation.height-1;
      if(indexEnd - indexStart > config.maxRead) {
        indexStart = indexEnd - config.maxRead;
      }

      InMessage
        .find({'conversation': conversation._id})
        .where('index').gte(indexStart).lte(indexEnd)
        .sort('index')
        .select('-_id dateReceived index message verified')
        .exec(function(err, inMsgs) {
        if(err) {
          return sendErrorJSON(res, err, 500);
        }

        OutMessage
          .find({'conversation': conversation._id})
          .where('index').gte(indexStart).lte(indexEnd)
          .sort('index')
          .select('-_id index lastStatusChange message status')
          .exec(function(err, outMsgs) {
          if(err) {
            return sendErrorJSON(res, err, 500);
          }

          res.json({'in': inMsgs, 'out': outMsgs});
        });
      });
    });
  });
};


// Retrieve account information
exports.fetchAccount = function(req, res) {
  req.query.accountName = req.query.accountName || req.headers.accountname;
  if(req.headers.accountname !== 'root' && req.headers.accountname !== req.query.accountName) {
    return sendErrorJSON(res, 'Not authorized to view this account', 403);
  }

  Account
    .findOne({peerId: req.headers.peerid, accountName: req.query.accountName})
    .select('-_id accountName activeGroup enabled peerId')
    .populate('activeGroup')
    .exec(function(err, acct) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    acct = acct.toObject();
    if(!!acct.activeGroup) {
      acct.activeGroup = acct.activeGroup.name;
    }
    res.json(acct);
  });
};

// Update account settings
exports.updateAccount = function(req, res) {
  req.body.accountName = req.body.accountName || req.headers.accountname;
  if(req.headers.accountname !== 'root' && req.headers.accountname !== req.body.accountName) {
    return sendErrorJSON(res, 'Not authorized to update this account', 403);
  }

  Account
    .findOne({peerId: req.headers.peerid, accountName: req.body.accountName})
    .select('accountName activeGroup enabled peerId tokenHash')
    .populate('activeGroup')
    .exec(function(err, account){
    if(err) {
      return sendErrorJSON(res, err, 500);
    }
    if(!account) {
      return sendErrorJSON(res, 'Account "' + formatPeerString(req.headers.peerid, req.body.accountName) + '" does not exist', 404);
    }

    // Keep track of active group's name, if exists
    var finalActiveGroupName;

    return new Promise((resolve, reject) => {
      // Enable if disabled, and disable if enabled
      if(req.body.enabled === 'true' && account.enabled === false) {
        // Enable account in DB
        account.enabled = true;

        // Start listening for this account
        Group.find({owner: account._id}, function(err, groups) {
          if(err) {
            return reject({'err': err, 'code': 500});
          }

          for(var i = 0; i < groups.length; i++) {
            distort_ipfs.subscribe(groups[i].name, groups[i].subgroupIndex);
          }
          return resolve(account);
        });
      } else if(req.body.enabled === 'false' && account.enabled === true) {
        // Only non-root users may be disabled
        if(req.body.accountName === 'root') {
          return reject({'err': '"root" account cannot be disabled', 'code': 403});
        }

        // Disable account in DB
        account.enabled = false;

        // Stop listening for this account
        Group.find({owner: account._id}, function(err, groups) {
          if(err) {
            return reject({'err': err, 'code': 500});
          }

          for(var i = 0; i < groups.length; i++) {
            distort_ipfs.unsubscribe(groups[i].name, groups[i].subgroupIndex);
          }
          return resolve(account);
        });
      } else {
        return resolve(account);
      }
    }).then((account) => {
      if(account.activeGroup) {
        return Group.findById(account.activeGroup).then((activeGroup) => {
          finalActiveGroupName = activeGroup.name;

          return new Promise((resolve, reject) => {
            // set active group of account
            if(typeof req.body.activeGroup === 'string') {
              if(req.body.activeGroup) {
                Group.findOne({owner: account._id, name: req.body.activeGroup}, function(err, newActiveGroup) {
                  if(err) {
                    return reject(err);
                  }

                  account.activeGroup = newActiveGroup;
                  finalActiveGroupName = newActiveGroup.name;
                  return resolve(account);
                });
              } else {
                delete account['activeGroup'];
                finalActiveGroupName = "";
                return resolve(account);
              }
            } else {
              return resolve(account);
            }
          });
        }).catch(err => {
          throw {'err': err, 'code': 500};
        });
      } else {
        return Promise.resolve(account);
      }
    }).then((account) => {
      // Allow updating of password by submitting new authentication-token
      if(req.body.authToken && typeof req.body.authToken === "string") {
        account.tokenHash = sjcl.codec.base64.fromBits(sjcl.hash.sha256.hash(req.body.authToken));
      }
      return account;
    }).then((account) => {
      account.save().then(account => {
        account = account.toObject();
        delete account['_id'];
        delete account['__v'];
        account.activeGroup = finalActiveGroupName;

        res.json(account);
      }).catch(err => {
          return sendErrorJSON(res, err, 500);
      });
    }).catch((error) => {
      return sendErrorJSON(res, error.err, error.code);
    });
  });
};

// Allow the root account to delete a specified non-root account
exports.deleteAccount = function(req, res) {
  if(req.headers.accountname !== 'root') {
    return sendErrorJSON(res, 'Only the "root" account may remove accounts', 403);
  }
  if(!req.body.accountName) {
    return sendErrorJSON(res, 'Must specify an account to remove', 400);
  }

  Account.findOne({peerId: req.headers.peerid, accountName: req.body.accountName}, function(err, account) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }
    if(!account) {
      return sendErrorJSON(res, 'Account "' + formatPeerString(req.headers.peerid, req.body.accountName) + '" does not exist', 404);
    }

    // Delete all conversations and groups belonging to account
    // Invalidate certificates
    removeMatchingConversations({owner: account._id}).then(() => {
      Group.remove({owner: account._id}).then(() => {
        Cert.update({peerId: req.headers.peerid, accountName: req.body.accountName, status: 'valid'}, {$set: {status: 'invalidated'}}).then(() => {
          account.remove(function(err) {
            sendMessageJSON(res, 'Successfully removed account: ' + req.body.accountName);
          });
        });
      }).catch(err => {
        if(err) {
          return sendErrorJSON(res, err, 500);
        }
      });
    });
  });
};


// Retrieve account peers
exports.fetchPeers = function(req, res) {
  Account.findOne({peerId: req.headers.peerid, accountName: req.headers.accountname}, function(err, acct) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    Peer
      .find({owner: acct._id})
      .populate({path: 'cert', select: '-_id groups'})
      .select('-_id accountName peerId nickname cert')
      .exec(function(err, peers) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }

      for(var i = 0; i < peers.length; i++)  {
        peers[i] = peers[i].toObject();
        const groups = peers[i].cert.groups;
        delete peers[i]['cert'];
        peers[i].groups = groups;
      }

      res.json(peers);
    });
  });
};

// Retrieve account peers
exports.addPeer = function(req, res) {
  if(!req.body.peerId) {
    sendErrorJSON(res, "Requires IPFS-ID of peer to add", 400);
  }

  Account.findOne({peerId: req.headers.peerid, accountName: req.headers.accountname}, function(err, acct) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    var newPeer = {
      nickname: req.body.nickname,
      owner: acct._id,
      peerId: req.body.peerId,
      accountName: req.body.accountName || 'root'
    };

    // Ensure account does not already exist
    Peer.findOne({peerId: newPeer.peerId, accountName: newPeer.accountName, owner: newPeer.owner}, function(err, peer) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }

      // If peer exists, use this to update nickname. Otherwise create new peer
      if(peer) {
        peer.nickname = newPeer.nickname;
      } else {
        peer = new Peer(newPeer);
      }

      Cert.findOne({peerId: peer.peerId, accountName: peer.accountName, status: 'valid'}, function(err, cert) {
        if(err) {
          return sendErrorJSON(res, err, 500);
        }
        if(!cert) {
          return sendErrorJSON(res, "Cannot add a peer until discovery of their certificate. Please wait for their next routine certificate post", 404);
        }

        // If there exists a certificate for this user already, assign to this peer
        if(cert) {
          peer.cert = cert._id;
        }

        peer.save(function(err, peer) {
          if(err) {
            return sendErrorJSON(res, err, 500);
          }
          peer.populate('cert', function(err) {
            if(err) {
              return sendErrorJSON(res, err, 500);
            }

            delete peer['_id'];
            delete peer['__v'];
            delete peer['owner'];
            peer.cert = peer.cert.groups

            res.json(peer);
          });
        });
      });
    })
  });
};

// Remove a peer from account's list
exports.removePeer = function(req, res) {
  if(!req.body.peerId) {
    return sendErrorJSON(res, "Requires IPFS-ID of peer to remove", 400);
  }

  Account.findOne({peerId: req.headers.peerid, accountName: req.headers.accountname}, function(err, acct) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }

    const accountName = req.body.accountName || 'root';
    Peer.findOne({owner: acct._id, peerId: req.body.peerId, accountName: accountName}, function(err, peer) {
      if(err) {
        return sendErrorJSON(res, err, 500);
      }

      const peerFullTitle = formatPeerString(req.body.peerId, req.body.accountName);
      if(!peer) {
        return sendErrorJSON(res, 'Account has no entry for peer: ' + peerFullTitle, 404);
      }

      Peer.remove({owner: acct._id, peerId: req.body.peerId, accountName: accountName}, function(err, delStats) {
        if(err) {
          return sendErrorJSON(res, err, 500);
        }

        sendMessageJSON(res, 'Successfully removed peer: ' + peerFullTitle);
      });
    });
  });
};


// Allow client account to sign hash of input text with their signing key
// This is necessary for allowing root account to allow generate account-creation tokens
exports.signText = function (req, res) {
  const peerId = req.headers.peerid;
  const accountName = req.headers.accountname;
  const plaintext = req.query.plaintext;

  // Fetch certificate if exists
  // NOTE: if reached code account must exist (they authenticated) so if missing is server error
  Cert.findOne({accountName: accountName, peerId: peerId}, function(err, cert) {
    if(err || !cert) {
      return sendErrorJSON(res, err || 'Unable to find certificate for account: ' + formatPeerString(peerId, accountName), 500);
    }

    // Get signature string from plaintext
    const sec = new sjcl.ecc.ecdsa.secretKey(secp256k1, new sjcl.bn(cert.key.sign.sec));
    const sig = sjcl.codec.hex.fromBits(sec.sign(sjcl.hash.sha256.hash(plaintext), PARANOIA));

    return sendMessageJSON(res, sig);
  });
};

// Allow client to verify that a given peer signed the specified text
exports.verifySignature = function(req, res) {
  const peerId = req.body.peerId;
  const accountName = req.body.accountName || 'root';
  const plaintext = req.body.plaintext;
  const signature = req.body.signature;

  // Fetch certificate if exists
  Cert.findOne({accountName: accountName, peerId: peerId}, function(err, cert) {
    if(err) {
      return sendErrorJSON(res, err, 500);
    }
    if(!cert) {
      return sendErrorJSON(res, 'Unable to find certificate for peer: ' + formatPeerString(peerId, accountName), 404);
    }

    // Get signature string from plaintext
    const publicKeyStrs = cert.key.sign.pub.split(':');
    const x = new sjcl.bn(publicKeyStrs[0]);
    const y = new sjcl.bn(publicKeyStrs[1]);
    const publicKey = new sjcl.ecc.ecdsa.publicKey(secp256k1, new sjcl.ecc.point(secp256k1, x, y));

    var verified;
    try {
      verified = !!publicKey.verify(sjcl.hash.sha256.hash(plaintext), sjcl.codec.hex.toBits(signature));
    } catch (e) {
      verified = false;
    }

    return sendMessageJSON(res, verified.toString());
  });
};
