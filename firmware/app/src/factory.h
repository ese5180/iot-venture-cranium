/*
 * Factory reset: remove everything that was provisioned onto this device.
 */

#ifndef FACTORY_H_
#define FACTORY_H_

#include <stdbool.h>

/* Security tag of the AWS IoT root CA, the device certificate and its private key. */
#define FACTORY_CLOUD_SEC_TAG    CONFIG_MQTT_HELPER_SEC_TAG
/* Security tag used for firmware downloads: it holds the root CA only. */
#define FACTORY_DOWNLOAD_SEC_TAG CONFIG_APP_DOWNLOAD_SEC_TAG

/*
 * Erase the Wi-Fi network, the cloud settings, the device certificate and private key,
 * the root CAs and any pending update record. The firmware itself is not touched.
 */
void factory_reset(void);

/* Whether a credential of the given kind is stored, without reading it out. */
bool factory_has_root_ca(void);
bool factory_has_certificate(void);
bool factory_has_private_key(void);

#endif /* FACTORY_H_ */
