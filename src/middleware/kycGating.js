/**
 * KYC Gating Middleware
 * Enforces KYC requirements before allowing access to sensitive endpoints
 *
 * @module middleware/kycGating
 */

const AppError = require('../errors/AppError');
const kycService = require('../services/kycService');
const logger = require('../logger');

/**
 * Middleware to enforce KYC verification for all capital-movement operations.
 *
 * Apply to every route that initiates or settles escrow funding:
 * - POST /api/invest/fund-invoice
 * - POST /api/invoices/:id/link-escrow
 * - POST /api/invoices/:id/transition  (when targetState is a capital-moving state)
 * - Any future endpoint that transfers or releases capital
 *
 * Security contract:
 * - User MUST be authenticated (`req.user` populated by `authenticateToken`).
 * - `smeId` is resolved ONLY from the authenticated JWT principal (`req.user.smeId`).
 *   Callers CANNOT override this via `req.body.smeId` or `req.params.smeId` — doing
 *   so would allow an attacker to supply a verified SME's ID they do not own.
 * - SME must hold KYC status of 'verified' or 'exempted'.
 * - Tenant isolation is enforced upstream (via `extractTenant` middleware).
 *
 * @param {import('express').Request}  req  - Express request object
 * @param {import('express').Response} res  - Express response object
 * @param {import('express').NextFunction} next - Express next middleware
 * @returns {Promise<void>}
 * @throws {AppError} 401 if unauthenticated
 * @throws {AppError} 400 if the JWT contains no smeId claim
 * @throws {AppError} 403 if KYC requirements are not met
 */
async function requireKycForFunding(req, res, next) {
  try {
    // 1. Validate authentication — authenticateToken must have run first.
    if (!req.user || !req.user.sub) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required for KYC-gated operations.',
        instance: req.originalUrl,
        code: 'UNAUTHORIZED',
      });
      return next(error);
    }

    // 2. Resolve smeId STRICTLY from the authenticated JWT principal.
    //
    //    SECURITY NOTE: We intentionally do NOT fall back to req.body.smeId or
    //    req.params.smeId.  If we did, any authenticated user could supply a
    //    verified SME's ID in the request body/params and pass the KYC gate for
    //    an SME they do not own.  The smeId MUST come from the token that was
    //    issued to this specific principal.
    //
    //    Convention: tokens may carry the SME identity as either `smeId` or,
    //    for tokens where the subject *is* the SME, as `sub`.
    const smeId = req.user.smeId || null;

    if (!smeId) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'SME ID is required for funding operations. Ensure your JWT contains a valid smeId claim.',
        instance: req.originalUrl,
        code: 'MISSING_SME_ID',
      });
      return next(error);
    }

    // 3. Check KYC status for the authenticated principal's SME.
    const kycRecord = await kycService.getKycStatus(smeId);
    const canFund = kycService.canFundWithKycStatus(kycRecord.status);

    logger.info(
      {
        userId: req.user.sub,
        smeId,
        kycStatus: kycRecord.status,
        canFund,
        requestId: req.id,
      },
      'KYC gate check'
    );

    // 4. Enforce gate — block if KYC is not in an acceptable state.
    if (!canFund) {
      const error = new AppError({
        type: 'https://liquifact.com/probs/kyc-required',
        title: 'KYC Verification Required',
        status: 403,
        detail: `SME KYC status '${kycRecord.status}' does not permit funding operations. Status must be 'verified' or 'exempted'.`,
        instance: req.originalUrl,
        code: 'KYC_GATE_FAILED',
        retryable: false,
        retryHint: 'Complete KYC verification and try again.',
      });
      return next(error);
    }

    // 5. Attach verified KYC metadata to the request for downstream handlers.
    req.kyc = {
      smeId,
      status: kycRecord.status,
      recordId: kycRecord.recordId,
      verifiedAt: kycRecord.verifiedAt,
    };

    next();
  } catch (error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
        requestId: req.id,
      },
      'KYC gating middleware error'
    );

    const appError = new AppError({
      type: 'https://liquifact.com/probs/internal-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An error occurred while checking KYC status.',
      instance: req.originalUrl,
      code: 'KYC_CHECK_FAILED',
      retryable: true,
    });

    next(appError);
  }
}

/**
 * Middleware to log KYC access for audit trails.
 * Attach after `requireKycForFunding` on gated routes to record every
 * successful capital-movement access.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function auditKycAccess(req, res, next) {
  if (req.kyc) {
    logger.debug(
      {
        userId: req.user?.sub,
        smeId: req.kyc.smeId,
        kycStatus: req.kyc.status,
        endpoint: req.path,
        method: req.method,
        requestId: req.id,
      },
      'KYC-gated endpoint accessed'
    );
  }
  next();
}

module.exports = {
  requireKycForFunding,
  auditKycAccess,
};
