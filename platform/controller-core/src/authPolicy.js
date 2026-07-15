import { domainError, ERROR_CODES } from './errors.js';

export class AuthPolicy {
  constructor({ verifyCredential, ipAllowed }) {
    this.verifyCredential = verifyCredential;
    this.ipAllowed = ipAllowed;
  }

  decide(context) {
    if (context.sourceAddress && !this.ipAllowed(context.sourceAddress)) {
      return deny('IP not allowed');
    }
    if (context.credentialVerificationResult === true) return allow(context);
    if (this.verifyCredential?.(context) === true) return allow(context);
    return deny('Unauthorized');
  }

  require(context) {
    const decision = this.decide(context);
    if (!decision.allowed) throw domainError(ERROR_CODES.AUTH_DENIED, decision.reason, 401);
    return decision;
  }
}

function allow(context) {
  return { allowed: true, actorType: context.actorType, actorId: context.actorId, action: context.requestedAction };
}

function deny(reason) {
  return { allowed: false, reason };
}
