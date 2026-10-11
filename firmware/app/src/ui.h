/*
 * LED1 and the two buttons.
 *
 * LED1 shows what the security domain is doing. LED2 belongs to the network core and
 * is not touched here.
 */

#ifndef UI_H_
#define UI_H_

enum ui_state {
	/* Short flash every two seconds: the device has not been provisioned. */
	UI_UNPROVISIONED,
	/* Slow blink: joining Wi-Fi. */
	UI_NETWORK_CONNECTING,
	/* Medium blink: Wi-Fi is up, connecting to the cloud. */
	UI_CLOUD_CONNECTING,
	/* Steady: connected, nothing to do. */
	UI_ONLINE,
	/* Fast blink: an update is waiting for a button press. */
	UI_UPDATE_OFFERED,
	/* Double flash: downloading or checking an update. */
	UI_UPDATE_IN_PROGRESS,
	/* Triple flash: a new image is running on trial. */
	UI_UPDATE_TESTING,
};

int ui_init(void);
void ui_set_state(enum ui_state state);

#endif /* UI_H_ */
