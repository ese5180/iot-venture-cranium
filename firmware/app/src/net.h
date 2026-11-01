/*
 * Wi-Fi station.
 *
 * Network credentials are provisioned at run time and stored through PSA in TF-M;
 * they are never part of the firmware image. Only WPA2-PSK and WPA3-SAE networks are
 * accepted: open, WEP and WPA (TKIP) networks are refused both when credentials are
 * stored and after association.
 *
 * Joining never blocks anyone: net_connect() starts it, and the result arrives later as
 * APP_EVENT_NET_UP or APP_EVENT_NET_JOIN_FAILED. Each one ends up as a [WIFI] line on the
 * console. Passwords go into storage and nowhere else.
 */

#ifndef NET_H_
#define NET_H_

#include <stdbool.h>
#include <stddef.h>

#define NET_SSID_MAX     32
#define NET_PASSWORD_MIN 8
#define NET_PASSWORD_MAX 63

enum net_security {
	NET_SECURITY_WPA2_PSK,
	NET_SECURITY_WPA2_PSK_SHA256,
	NET_SECURITY_WPA3_SAE,
};

/* What the console shows. Nothing here is secret. */
struct net_status {
	bool stored;
	bool connected;
	char ssid[NET_SSID_MAX + 1];
	char ip[16];
	int rssi;
	char mac[18];
};

/* Bring the interface up and remove stored networks that policy does not allow. */
int net_init(void);

/* Start joining a stored network. Returns -ENOENT when none is stored. */
int net_connect(void);

/* Called once a second: retries the connection when it has been down for a while. */
void net_tick(void);

/* Say on the console what happened. Called by the main loop for the events above. */
void net_report_up(void);
void net_report_down(void);
void net_report_join_failed(int reason);

bool net_is_up(void);
bool net_has_credentials(void);

#if defined(CONFIG_APP_BT_OTA)
/* The Wi-Fi stack has reported the result of a join attempt, good or bad, since this image started. */
bool net_wifi_answered(void);

/*
 * The station is associated with an access point, whether or not it has an address yet, as the
 * Wi-Fi stack says now. Also true if it cannot say.
 */
bool net_wifi_associated(void);
#endif

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

/* What is stored and what the link is doing. Safe from any thread. */
void net_status_get(struct net_status *status);

#endif /* NET_H_ */
