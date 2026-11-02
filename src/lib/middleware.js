import { getAdminSession } from "./auth.js";
import { getLicenseSession } from "./licenses.js";

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function requireAdmin(request, reply) {
  const token = bearerToken(request);
  const session = token ? getAdminSession(token) : null;

  if (!session) {
    return reply.code(401).send({
      error: { code: "ADMIN_UNAUTHORIZED", message: "Admin authentication is required" },
    });
  }

  request.adminSession = session;
}

export async function requireLicenseSession(request, reply) {
  const token = bearerToken(request);
  const session = token ? getLicenseSession(token) : null;

  if (!session) {
    return reply.code(401).send({
      error: {
        code: "LICENSE_SESSION_INVALID",
        message: "The license session is invalid, expired, or revoked",
      },
    });
  }

  request.licenseSession = session;
}
