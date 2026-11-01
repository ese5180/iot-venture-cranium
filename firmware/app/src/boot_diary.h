/*
 * A record of the last boots, for finding out over the cloud why a board reset when nobody can
 * read its serial port. With CONFIG_APP_BOOT_DIARY. Each entry is version/cause/stage, where the
 * cause is why the boot before it ended, in Zephyr's hwinfo RESET_ bits.
 */

#ifndef BOOT_DIARY_H_
#define BOOT_DIARY_H_

enum boot_diary_stage {
	BOOT_DIARY_MAIN = 1,
	BOOT_DIARY_OTA_READY = 2,
	BOOT_DIARY_NET_UP = 3,
	BOOT_DIARY_CLOUD_UP = 4,
};

/* First thing in main(): a new entry, with why the last boot ended. */
void boot_diary_begin(void);

/* How far this boot has got. Each stage writes to storage, so a reset right after it still shows. */
void boot_diary_stage(enum boot_diary_stage stage);

/* Send the entries to the device shadow as "diary". */
void boot_diary_report(void);

#endif /* BOOT_DIARY_H_ */
