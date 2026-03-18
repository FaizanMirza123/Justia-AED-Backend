import jwt from "jsonwebtoken";

/**
 * Required auth - rejects if no valid token
 */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

/**
 * Optional auth - attaches user if valid token exists, otherwise continues
 */
export function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name };
  } catch {
    req.user = null;
  }
  next();
}

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}
