/**
 * Authentication Middleware
 * Validates JWT tokens in the Authorization header.
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');
const AppError = require('../errors/AppError');
const configModule = require('../config');

/**
 * Middleware function to enforce authentication for protected routes.
 * It checks the "Authorization" header for a "Bearer <token>" pattern.
 * If valid, it attaches the decoded token payload to `req.user`.
 * 
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next middleware function
 * @returns {void}
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication token is required',
      instance: req.originalUrl,
    }));
  }

  const tokenParts = authHeader.split(' ');
  
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid Authorization header format. Expected "Bearer <token>"',
      instance: req.originalUrl,
    }));
  }

  const token = tokenParts[1];
  
  let config;
  try {
    config = configModule.get();
  } catch (_err) {
    // Fallback for tests or before config is validated
    config = {
      JWT_SECRET: process.env.JWT_SECRET || 'test-secret',
      JWT_ISSUER: process.env.JWT_ISSUER || 'liquifact-platform',
      JWT_AUDIENCE: process.env.JWT_AUDIENCE || 'liquifact-client',
      JWT_ALGORITHMS: process.env.JWT_ALGORITHMS || 'HS256',
    };
  }

  const secret = config.JWT_SECRET;
  const algorithms = config.JWT_ALGORITHMS ? config.JWT_ALGORITHMS.split(',').map(s => s.trim()) : ['HS256'];
  const options = {
    algorithms,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  };

  jwt.verify(token, secret, options, (_err, decoded) => {
    if (_err) {
      if (_err.name === 'TokenExpiredError') {
        return next(new AppError({
          type: 'https://liquifact.com/probs/token-expired',
          title: 'Token Expired',
          status: 401,
          detail: 'Token has expired',
          instance: req.originalUrl,
        }));
      }
      return next(new AppError({
        type: 'https://liquifact.com/probs/invalid-token',
        title: 'Invalid Token',
        status: 401,
        detail: 'Invalid token',
        instance: req.originalUrl,
      }));
    }
    
    // Attach user info to the request pattern
    req.user = decoded;
    next();
  });
};

module.exports = { authenticateToken };
