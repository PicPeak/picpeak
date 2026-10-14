/**
 * logActivity's actor for an admin the caller knows only by id. logActivity
 * reads `{ type, id, name }`; a string such as `admin:5` is stored as the
 * system with no id. Without an id nobody signed in triggered the action
 * (a scheduler, the booking flow), so it is the system's.
 */
function adminActivityActor(adminId) {
  return adminId ? { type: 'admin', id: adminId } : { type: 'system' };
}

module.exports = { adminActivityActor };
