/**
 * Active Call Registry Service
 * Tracks all active calls (direct and group) with their participants
 * Instructions from GPT-5.6-Luna via Experiential Gateway
 */

const calls = new Map();

/*
Map structure:
callId -> {
  callType: "direct" | "group",
  participants: Map<userId, {
    userId,
    socketIds: Set<string>
  }>,
  createdAt
}
*/

function ensureCall(callId, callType) {
  let call = calls.get(callId);

  if (!call) {
    call = {
      callId,
      callType,
      participants: new Map(),
      createdAt: Date.now(),
    };

    calls.set(callId, call);
  }

  return call;
}

function addParticipant(callId, callType, userId, socketId) {
  const call = ensureCall(callId, callType);

  let participant = call.participants.get(String(userId));

  if (!participant) {
    participant = {
      userId: String(userId),
      socketIds: new Set(),
    };

    call.participants.set(String(userId), participant);
  }

  participant.socketIds.add(socketId);

  return call;
}

function removeParticipant(callId, userId, socketId) {
  const call = calls.get(callId);

  if (!call) {
    return null;
  }

  const participant = call.participants.get(String(userId));

  if (participant) {
    if (socketId) {
      participant.socketIds.delete(socketId);
    }

    if (!socketId || participant.socketIds.size === 0) {
      call.participants.delete(String(userId));
    }
  }

  if (call.participants.size === 0) {
    calls.delete(callId);
  }

  return call;
}

function getCall(callId) {
  return calls.get(callId);
}

function deleteCall(callId) {
  return calls.delete(callId);
}

module.exports = {
  addParticipant,
  removeParticipant,
  getCall,
  deleteCall,
};
