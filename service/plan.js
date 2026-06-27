// service/onboarding.js

const { Entity } = require('@drumee/server-core');
const { toArray, Cache, Remit, Attr } = require('@drumee/server-essentials');
const { isEmpty } = require('lodash');
class Plan extends Entity {

  // initialize(opt) {
  //   super.initialize(opt);
  //   this.conf = Cache.getSysConf('payment_conf');
  //   let { db_name } = JSON.parse(this.conf);
  //   this.app_db = db_name;
  //   console.log("Onboarding Service Initialized.  Config:", db_name, this.conf);
  // }


  /**
   * 
   * @returns 
   */
  async upgrade() {
    // check payement validity
    let name = this.input.need(Attr.name);
    let plan = this.input.get('plan') || 'pro';
    let ident = this.input.need(Attr.ident);
    ident = ident.toLowerCase();
    let recds = { ident, name };
    let org;

    let chk = await this.user.organization();
    if (chk && chk.domain_id > 1) return this.output.status('already_in_other_domain');

    chk = await this.yp.await_proc('ident_exists', ident)
    if (!isEmpty(chk)) return this.output.status('domain_not_available');

    let domain = await this.yp.await_proc('domain_create', ident);
    await this.yp.await_proc('domain_grant', domain.id, Remit.dom_owner, this.uid, 0);
    recds.domain_id = domain.id;
    recds.owner_id = this.uid;
    recds.link = domain.name
    org = await this.yp.await_proc('organisation_add',
      this.uid, name, domain.name, ident, domain.id, recds
    );

    // yp.plan was migrated to the Stripe catalog schema: `capacity`->`quota`,
    // `name`->`plan_code`, and there can be several rows per plan_code (e.g.
    // pro/month + pro/year, same quota JSON) — LIMIT 1 keeps one so the insert
    // can't violate quota's (domain_id, payer_id) key.
    await this.yp.await_query(
      `INSERT INTO quota (domain_id, payer_id, quota) SELECT ?, ?, plan.quota FROM plan WHERE plan.plan_code=? LIMIT 1`,
      domain.id, this.uid, plan
    )

    this.output.data(org);
  }
}

module.exports = Plan;