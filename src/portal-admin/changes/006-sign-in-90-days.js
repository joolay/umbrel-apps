'use strict';
// People stay signed in until 90 days after they last used an app. Each app and the dashboard swap the sign-in for a fresh one whenever it is used,
// so PocketBase must let a sign-in live that long (its default is much shorter).
const DAYS = 90, SECONDS = DAYS * 86400, COLL = 'users';
module.exports = {
  id: '006-sign-in-90-days',
  title: 'Stay signed in for 90 days',
  summary: `Lets a JoolzApp sign-in last ${DAYS} days. Apps renew it every time they are used, so you only have to sign in again after ${DAYS} days without opening an app. Apps are updated separately.`,
  async plan(c) {
    const col = await c.getCollection(COLL);
    if (!col) return [];
    return (col.authToken && col.authToken.duration) === SECONDS ? [] : [`Set how long a sign-in lasts on ${COLL} to ${DAYS} days`];
  },
  async apply(c) {
    await c.needNewPocketBase();
    const col = await c.getCollection(COLL);
    if (!col) return ['The users collection does not exist yet, so nothing was changed.'];
    await c.pb('PATCH', '/api/collections/' + COLL, { authToken: { ...(col.authToken || {}), duration: SECONDS } });
    return [`Sign-ins now last ${DAYS} days. People already signed in keep their current sign-in until the app next renews it.`];
  },
};
