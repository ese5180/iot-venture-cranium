#include "device.h"

#include <errno.h>
#include <stdint.h>
#include <string.h>

#include "factory.h"
#include "identity.h"
#include "store.h"

#define FLAG_COMPLETE 0x494e4954 /* "INIT" */
#define FLAG_WIPING   0x57495045 /* "WIPE" */

/* Fixed size: store_read() takes a record of one exact size. */
struct id_record {
	char text[DEVICE_ID_MAX + 1];
};

static struct id_record current;
/*
 * Both are written on the main loop. The console reads them without waiting for it: during
 * Button 2's factory reset that can show a half-cleared ID, always ended by a '\0', just
 * before the restart. Nothing depends on what such a read returns.
 */
static bool factory_mode = true;

bool device_id_valid(const char *id)
{
	size_t length = 0;

	for (; id[length] != '\0'; length++) {
		char c = id[length];

		if (length == DEVICE_ID_MAX ||
		    !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
			return false;
		}
	}

	return length > 0;
}

static int write_flag(uint32_t value)
{
	return store_write(STORE_INIT_FLAG, &value, sizeof(value));
}

/* Write the ID and read it back. On success it is also the current ID. */
static enum device_init_step write_id(const char *id)
{
	struct id_record written = { 0 };
	struct id_record back = { 0 };

	strncpy(written.text, id, sizeof(written.text) - 1);

	if (store_write(STORE_DEVICE_ID, &written, sizeof(written)) != 0) {
		return DEVICE_INIT_WRITE_ID;
	}

	if (store_read(STORE_DEVICE_ID, &back, sizeof(back)) != 0 ||
	    memcmp(&written, &back, sizeof(written)) != 0) {
		return DEVICE_INIT_READ_BACK;
	}

	current = written;
	return DEVICE_INIT_OK;
}

/* 0 if the current ID is a valid one from storage. -EIO if storage could not be read. */
static int load_id(void)
{
	int err = store_read(STORE_DEVICE_ID, &current, sizeof(current));

	if (err == 0 && (current.text[DEVICE_ID_MAX] != '\0' || !device_id_valid(current.text))) {
		err = -EINVAL;
	}

	if (err != 0) {
		memset(&current, 0, sizeof(current));
	}

	return err;
}

static void show_soc_id(void)
{
	strncpy(current.text, identity_soc_id(), sizeof(current.text) - 1);
}

/* Cloud settings, a key and a certificate: this board has been in use. */
static bool was_provisioned(void)
{
	return identity_settings_get() != NULL && factory_has_private_key() &&
	       factory_has_certificate();
}

enum device_boot device_boot(void)
{
	const char *soc_id = identity_soc_id();
	uint32_t flag = 0;
	int flag_err = store_read(STORE_INIT_FLAG, &flag, sizeof(flag));
	int id_err = load_id();

	factory_mode = false;

	if (flag_err == 0 && flag == FLAG_COMPLETE && id_err == 0) {
		return DEVICE_BOOT_OPERATING;
	}

	/* A read that failed says nothing about what is stored, so nothing is written either. */
	if ((flag_err == -EIO || (flag == FLAG_COMPLETE && id_err == -EIO)) && was_provisioned()) {
		if (id_err != 0) {
			show_soc_id();
		}

		return DEVICE_BOOT_UNREADABLE;
	}

	if (flag_err == -ENOENT && was_provisioned() && device_id_valid(soc_id)) {
		if (write_id(soc_id) != DEVICE_INIT_OK || write_flag(FLAG_COMPLETE) != 0) {
			show_soc_id();
			return DEVICE_BOOT_MIGRATION_FAILED;
		}

		return DEVICE_BOOT_MIGRATED;
	}

	factory_mode = true;
	return DEVICE_BOOT_FACTORY;
}

bool device_is_factory(void)
{
	return factory_mode;
}

const char *device_id(void)
{
	return current.text;
}

int device_id_set(const char *id)
{
	if (!device_id_valid(id)) {
		return -EINVAL;
	}

	return write_id(id) == DEVICE_INIT_OK ? 0 : -EIO;
}

enum device_init_step device_init_prepare(const char *id)
{
	if (factory_reset() != 0) {
		return DEVICE_INIT_ERASE;
	}

	return write_id(id);
}

enum device_init_step device_init_finish(void)
{
	return write_flag(FLAG_COMPLETE) == 0 ? DEVICE_INIT_OK : DEVICE_INIT_WRITE_FLAG;
}

const char *device_init_step_name(enum device_init_step step)
{
	static const char *const names[] = {
		[DEVICE_INIT_OK] = "none",
		[DEVICE_INIT_ERASE] = "erase settings",
		[DEVICE_INIT_WRITE_ID] = "write id",
		[DEVICE_INIT_READ_BACK] = "read back id",
		[DEVICE_INIT_WRITE_FLAG] = "write init flag",
	};

	return names[step];
}

int device_wipe_begin(void)
{
	factory_mode = true;
	memset(&current, 0, sizeof(current));

	return write_flag(FLAG_WIPING);
}

int device_wipe_end(bool everything_erased)
{
	int err = store_erase(STORE_DEVICE_ID);
	int flag_err = everything_erased ? store_erase(STORE_INIT_FLAG) : 0;

	return err ? err : flag_err;
}
