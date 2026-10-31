/*
 * The settable device ID and the init-complete flag, and what they mean at boot.
 *
 * The ID is a name people give the board. It is not the cloud identity: that stays the
 * thing name in identity.h, which is the certificate's subject and the MQTT client ID,
 * and nothing about authentication depends on this one.
 *
 * Both values are separate records in store.h, and the flag is written last, so that a
 * power cut during first-time setup leaves the board in factory mode. In factory mode
 * the event loop, the watchdog and the LED keep running, and the board does not try to
 * join a network until INIT has been run.
 *
 * Nothing here touches hardware, so firmware/tests/host runs this code against a fake
 * store. What changes something runs on the main loop, and the console calls it through
 * that. Reading the ID and the mode is fine from any thread: see device.c.
 */

#ifndef DEVICE_H_
#define DEVICE_H_

#include <stdbool.h>

#define DEVICE_ID_MAX 32

enum device_boot {
	/* The flag and a valid ID are stored: normal operation. */
	DEVICE_BOOT_OPERATING,
	/* First-time setup has to be done. */
	DEVICE_BOOT_FACTORY,
	/* Provisioned by firmware older than the flag: given an ID and the flag. */
	DEVICE_BOOT_MIGRATED,
	/*
	 * The same, but the records could not be stored. The board runs normally anyway
	 * and tries again at the next boot: an update on trial must never be held up here.
	 */
	DEVICE_BOOT_MIGRATION_FAILED,
	/*
	 * A provisioned board whose flag or ID could not be read: storage failed, which
	 * does not make it a blank board. It runs normally and writes nothing, and shows the
	 * SoC's identifier if it has no ID to show. A confirmed board must not fall off the
	 * network, and a trial must not roll back, because of one failed read.
	 */
	DEVICE_BOOT_UNREADABLE,
};

/* The steps of first-time setup that can fail, for the console's error message. */
enum device_init_step {
	DEVICE_INIT_OK,
	DEVICE_INIT_ERASE,
	DEVICE_INIT_WRITE_ID,
	DEVICE_INIT_READ_BACK,
	DEVICE_INIT_WRITE_FLAG,
};

/* 1-32 letters or digits. */
bool device_id_valid(const char *id);

/*
 * Decide the mode at boot, once identity_init() has run. A board with cloud settings, a
 * private key and a certificate has been in use, so a missing flag means firmware older
 * than the flag rather than erased storage. Sending it to factory mode would keep an
 * update on trial from ever reaching the cloud, so that it would always roll back. It
 * gets the SoC's identifier as its ID, and the flag, and runs normally.
 */
enum device_boot device_boot(void);

bool device_is_factory(void);

/* The stored ID, or an empty string if there is none. */
const char *device_id(void);

/* Change the ID and keep everything else. Reads it back before saying it worked. */
int device_id_set(const char *id);

/*
 * First-time setup, for an ID that has been checked with device_id_valid(): erase all
 * persistent settings, write the ID, read it back. device_init_finish() then writes the
 * flag. From the first erase on, this board counts as being in factory mode.
 */
enum device_init_step device_init_prepare(const char *id);
enum device_init_step device_init_finish(void);

const char *device_init_step_name(enum device_init_step step);

/*
 * A factory reset starts and ends with these. The first replaces the flag in one write,
 * so that a power cut in the middle of the reset can neither leave the board operating
 * nor make it look like an old board to migrate, and puts the board in factory mode. The
 * second removes the ID, and the flag if everything else went. If something is left
 * behind, the flag stays as it is: the board comes back in factory mode, where INIT
 * erases again, and it is never taken for an old board with its credentials intact.
 */
int device_wipe_begin(void);
int device_wipe_end(bool everything_erased);

#endif /* DEVICE_H_ */
