// service/invite.js

const { Entity } = require('@drumee/server-core');
const { isArray, isEmpty } = require('lodash');

class Invite extends Entity {
  /**
   * Redeem a share-link hub invite token after the user has signed up / signed in.
   * Input: { token }
   */
  async accept_invite() {
    const secret = this.input.need('token');
    if (!this.uid) {
      return this.exception.user('Authentication required.');
    }

    let tok = await this.yp.await_proc('token_get_next', secret);
    if (isArray(tok)) tok = tok[0];
    if (isEmpty(tok)) {
      return this.exception.user('INVITE_TOKEN_NOT_FOUND');
    }
    if (!/^hub_invite:/.test(tok.method || '')) {
      return this.exception.user('INVITE_TOKEN_INVALID');
    }
    if (tok.status !== 'active') {
      return this.exception.user('INVITE_TOKEN_USED');
    }

    let meta = tok.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
    }
    const hub_id = meta && meta.hub_id;
    const permission = meta && meta.permission;
    if (!hub_id || permission == null) {
      return this.exception.user('INVITE_TOKEN_INVALID');
    }

    const userEntity = await this.yp.await_proc('get_entity', this.uid);
    const userDbName = userEntity && userEntity.db_name;
    const hubDbName = await this.yp.await_func('get_db_name', hub_id);
    if (!userDbName || !hubDbName) {
      return this.exception.user('INVITE_HUB_UNAVAILABLE');
    }

    await this.yp.await_proc(`${userDbName}.join_hub`, hub_id);
    await this.yp.await_proc(
      `${userDbName}.permission_grant`,
      hub_id, this.uid, 0, permission, 'system', 'Accepted hub invite token'
    );
    await this.yp.await_proc(
      `${hubDbName}.permission_grant`,
      '*', this.uid, 0, permission, 'system', 'Accepted hub invite token'
    );

    const newMeta = JSON.stringify({
      ...meta,
      accepted_by: this.uid,
      accepted_at: Math.floor(Date.now() / 1000),
    });
    await this.yp.await_proc('token_hub_invite_set_status', secret, 'accepted', newMeta);

    this.output.data({ success: true, hub_id });
  }
}

module.exports = Invite;
