// Shared by every tenant-admin endpoint. The service connects as svc_tenant_admin,
// never as the owner role.
export const TENANT_ADMIN_DB = 'DATABASE_URL_SVC_TENANT_ADMIN';
