#include "boot_diary.h"

#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include "cloud.h"
#include "console.h"
#include "store.h"
#include "version.h"

LOG_MODULE_REGISTER(boot_diary, CONFIG_APP_LOG_LEVEL);

#define ENTRIES 8
#define DIARY_MAGIC 0x44494152u

struct entry {
	char version[16];
	/* Why the boot before this one ended: Zephyr's hwinfo RESET_ bits. */
	uint32_t cause;
	uint8_t stage;
};

static struct {
	uint32_t magic;
	uint32_t boots;
	uint8_t next;
	struct entry entries[ENTRIES];
} diary;

static uint8_t current;

void boot_diary_begin(void)
{
	if (store_read(STORE_BOOT_DIARY, &diary, sizeof(diary)) != 0 || diary.magic != DIARY_MAGIC ||
	    diary.next >= ENTRIES) {
		memset(&diary, 0, sizeof(diary));
		diary.magic = DIARY_MAGIC;
	}

	current = diary.next;
	diary.next = (diary.next + 1) % ENTRIES;
	diary.boots++;
	strncpy(diary.entries[current].version, fw_version_running_string(),
		sizeof(diary.entries[current].version) - 1);
	diary.entries[current].version[sizeof(diary.entries[current].version) - 1] = '\0';
	diary.entries[current].cause = console_last_reset_cause();
	diary.entries[current].stage = BOOT_DIARY_MAIN;
	(void)store_write(STORE_BOOT_DIARY, &diary, sizeof(diary));
}

void boot_diary_stage(enum boot_diary_stage stage)
{
	if (diary.entries[current].stage < stage) {
		diary.entries[current].stage = stage;
		(void)store_write(STORE_BOOT_DIARY, &diary, sizeof(diary));
	}
}

void boot_diary_report(void)
{
	static char json[480];
	size_t used = 0;

	used += snprintf(json + used, sizeof(json) - used, "{\"diary\":{\"boots\":%u,\"log\":[",
			 diary.boots);
	/* Oldest first. */
	for (size_t i = 0; i < ENTRIES && used < sizeof(json); i++) {
		const struct entry *entry = &diary.entries[(diary.next + i) % ENTRIES];

		if (entry->version[0] == '\0') {
			continue;
		}
		used += snprintf(json + used, sizeof(json) - used, "%s\"%s/%x/%u\"",
				 json[used - 1] == '[' ? "" : ",", entry->version, entry->cause,
				 entry->stage);
	}
	if (used + 3 < sizeof(json)) {
		strcpy(json + used, "]}}");
		(void)cloud_shadow_report(json);
	}
}
