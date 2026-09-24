// cam-guard platform adapters — example.
//
// cam-guard knows no chat platform: in `auto` mode it calls these functions
// and nothing else. Replace the bodies with calls to your platform's API.
// Each receives the subject `{ userId, roomId, displayName? }`; throwing marks
// the action as failed in the evidence, it does not stop the bot.
//
// `ban` is deliberately absent: permanent bans are taken by a human.

const log = (...args) => console.error("[adapter]", ...args);

/** Private message to the user. */
export async function warn(subject, text) {
  log("warn", subject.userId, "in", subject.roomId, "—", text);
}

/** Switch the user's camera off. */
export async function closeCam(subject) {
  log("closeCam", subject.userId, "in", subject.roomId);
}

/** Remove the user from the room. */
export async function kick(subject, reason) {
  log("kick", subject.userId, "from", subject.roomId, "—", reason);
}

/** Time-limited suspension from the platform. */
export async function suspend(subject, hours, reason) {
  log("suspend", subject.userId, `for ${hours} h`, "—", reason);
}

/**
 * Optional: every report- and act-level decision, in any mode, with the frame
 * (`notice.image.bytes`, `notice.image.mime`) — e.g. for a staff review queue.
 */
export async function report(subject, notice) {
  log("report", subject.userId, "in", subject.roomId, notice.level, notice.label, notice.topScore.toFixed(2));
}
