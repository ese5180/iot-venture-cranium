/*
 * Wi-Fi station.
 *
 * Network credentials are provisioned at run time and stored through PSA in TF-M;
 * they are never part of the firmware image. Only WPA2-PSK and WPA3-SAE networks are
 * accepted: open, WEP and WPA (TKIP) networks are refused both when credentials are
 * stored and after association.
 *
 * Joining never blocks anyone: net_connect() asks for it, and the result arrives later as
 * APP_EVENT_NET_UP or APP_EVENT_NET_JOIN_FAILED. Each one ends up as a [WIFI] line on the
 * console. Passwords go into storage and nowhere else.
 */

#ifndef NET_H_
#define NET_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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

/*
 * Bring the interface up and remove stored networks that policy does not allow. This does not wait
 * for the Wi-Fi stack, so it also returns on a chip that does not come up.
 */
int net_init(void);

/*
 * Ask to join a stored network, in the order that join_policy.h gives: a join on a board that is
 * associated, or whose link has just changed, is held by net_tick() until it may start. Returns
 * -ENOENT when none is stored, and -EAGAIN when the join has not started: it is being held, or the
 * Wi-Fi stack is not ready yet, and either way it starts by itself when it can.
 */
int net_connect(void);

/*
 * Called once a second: starts a join that was being held, and retries the connection when it has
 * been down for a while.
 */
void net_tick(void);

/* Say on the console what happened. Called by the main loop for the events above. */
void net_report_up(void);
void net_report_down(void);
void net_report_join_failed(int reason);

bool net_is_up(void);
bool net_has_credentials(void);

/*
 * How many results of join attempts the Wi-Fi stack has reported since this image started, good
 * or bad. "network not found" only comes after a scan that finished, which took the driver, the
 * chip's firmware and the supplicant. A failed request does not count, and neither does the
 * console's "no answer", which is what the absence of a result looks like. Not every join that
 * fails gets a result, and not every result took the chip: see STUCK_WIFI_SILENT_SECONDS.
 */
uint32_t net_wifi_answers(void);

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
