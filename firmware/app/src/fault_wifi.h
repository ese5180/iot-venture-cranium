/*
 * A test image's Wi-Fi fault, with CONFIG_APP_TEST_FAULT_WIFI_DEAD only: see src/fault_wifi.c.
 */

#ifndef FAULT_WIFI_H_
#define FAULT_WIFI_H_

/* Called by the main loop once a second. With CONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS it may fire. */
void fault_wifi_on_tick(void);

#endif /* FAULT_WIFI_H_ */
