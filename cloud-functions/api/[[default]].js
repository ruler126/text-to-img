import { getStore } from "@edgeone/pages-blob";
import { createApiHandler, getImageProxyBodyLimitBytes, getServerApiConfig } from "../../server/api-handler.mjs";
import { makeBlobLicenseStore } from "../../server/license-blob.mjs";

let handlerPromise;

const createHandler = async (env = process.env) => {
  const store = makeBlobLicenseStore({
    blobStore: getStore({ name: env.BLOB_STORE_NAME ?? "license-store", consistency: "strong" }),
    sessionSecret: env.SESSION_SECRET ?? "change-this-secret",
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
