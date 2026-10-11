#include "factory.h"

#include <errno.h>

#include <zephyr/logging/log.h>
#include <zephyr/net/tls_credentials.h>

#include "identity.h"
#include "net.h"
#include "store.h"

LOG_MODULE_REGISTER(factory, CONFIG_APP_LOG_LEVEL);

static bool has_credential(sec_tag_t tag, enum tls_credential_type type)
{
	size_t length = 0;

	/* With a zero-length buffer nothing is copied; -EFBIG means it exists. */
	return tls_credential_get(tag, type, NULL, &length) != -ENOENT;
}

bool factory_has_root_ca(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE) &&
	       has_credential(FACTORY_DOWNLOAD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
}

bool factory_has_certificate(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);
}

bool factory_has_private_key(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
}

void factory_reset(void)
{
	LOG_WRN("Factory reset: erasing all provisioned data");

	(void)net_credentials_clear();
	(void)identity_settings_clear();
	(void)store_erase(STORE_OTA_RECORD);

	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);
	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
	(void)tls_credential_delete(FACTORY_DOWNLOAD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
}
