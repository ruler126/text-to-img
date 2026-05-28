import { createApiHandler, getImageProxyBodyLimitBytes, getServerApiConfig } from "../../server/api-handler.mjs";
import { makeMysqlLicenseStore } from "../../server/license-mysql.mjs";

let handlerPromise;

const createHandler = async (env = process.env) => {
  const store = await makeMysqlLicenseStore({
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET ?? "change-this-secret",
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT ?? 4) || 4,
  });

  return createApiHandler({
    store,
    adminPassword: env.ADMIN_PASSWORD ?? "",
    serverApiConfig: getServerApiConfig(env),
    imageProxyBodyLimitBytes: getImageProxyBodyLimitBytes(env),
  });
};

const getHandler = (env) => {
  if (!handlerPromise) {
    handlerPromise = createHandler(env);
  }
  return handlerPromise;
};

export async function onRequest(context) {
  const handler = await getHandler(context.env ?? process.env);
  return handler(context.request);
}

export default onRequest;
