/*
 * Wi-Fi station.
 *
 * Network credentials are provisioned at run time and stored through PSA in TF-M;
 * they are never part of the firmware image. Only WPA2-PSK and WPA3-SAE networks are
 * accepted: open, WEP and WPA (TKIP) networks are refused both when credentials are
 * stored and after association.
 */

#ifndef NET_H_
#define NET_H_

#include <stdbool.h>
#include <stddef.h>

enum net_security {
	NET_SECURITY_WPA2_PSK,
	NET_SECURITY_WPA2_PSK_SHA256,
	NET_SECURITY_WPA3_SAE,
};

/* Bring the interface up and remove stored networks that policy does not allow. */
int net_init(void);

/* Start joining a stored network. Returns -ENOENT when none is stored. */
int net_connect(void);

/* Called once a second: retries the connection when it has been down for a while. */
void net_tick(void);

bool net_is_up(void);
bool net_has_credentials(void);

/* Store the single network this device uses, replacing any other. */
int net_credentials_set(const char *ssid, size_t ssid_len, enum net_security security,
			const char *passphrase, size_t passphrase_len);
int net_credentials_clear(void);

/* Signal strength of the current association in dBm, or 0 when not connected. */
int net_rssi(void);

/*
 * The Wi-Fi interface's hardware address as text ("aa:bb:cc:dd:ee:ff"), for networks
 * that admit devices by address. buf needs 18 bytes.
 */
int net_mac_address(char *buf, size_t len);

#endif /* NET_H_ */
