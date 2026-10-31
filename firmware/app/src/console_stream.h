/*
 * The console's way of loading data larger than a line: a certificate, in chunks.
 *
 *   STREAM_START|<total_bytes>|<chunk_count>|<crc16_hex>|<CA or CERT>
 *   STREAM_CHUNK|<index>|<base64>
 *
 * Chunks must arrive in order, and a wrong index aborts the transfer. Nothing is applied
 * before the whole stream has passed its CRC-16/CCITT-FALSE, and a transfer that goes
 * quiet is given up after a while. Nothing here touches hardware. It runs on the console
 * task only.
 */

#ifndef CONSOLE_STREAM_H_
#define CONSOLE_STREAM_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* What a device certificate or root CA needs in DER form. */
#define CONSOLE_STREAM_MAX      1800
#define CONSOLE_STREAM_IDLE_MS  30000

enum console_stream_kind {
	CONSOLE_STREAM_CA,
	CONSOLE_STREAM_CERT,
};

enum console_stream_result {
	/* Chunk taken, more to come. */
	CONSOLE_STREAM_MORE,
	/* Last chunk taken and the CRC is right: the data can be applied. */
	CONSOLE_STREAM_COMPLETE,
	CONSOLE_STREAM_NOT_ACTIVE,
	/* The rest abort the transfer. */
	CONSOLE_STREAM_WRONG_INDEX,
	CONSOLE_STREAM_BAD_BASE64,
	CONSOLE_STREAM_TOO_MUCH,
	CONSOLE_STREAM_WRONG_LENGTH,
	CONSOLE_STREAM_BAD_CRC,
};

struct console_stream_status {
	bool active;
	enum console_stream_kind kind;
	uint32_t total;
	uint32_t received;
	uint32_t chunk_count;
	uint32_t next_index;
};

/* CRC-16/CCITT-FALSE: polynomial 0x1021, starts at 0xFFFF. crc is the running value. */
uint16_t console_crc16(uint16_t crc, const uint8_t *data, size_t length);

/* Starts a transfer and drops one that was under way. False if the numbers cannot work. */
bool console_stream_start(uint32_t total, uint32_t chunk_count, uint16_t crc,
			  enum console_stream_kind kind, int64_t now_ms);

enum console_stream_result console_stream_chunk(uint32_t index, const char *base64,
						int64_t now_ms);

/* After CONSOLE_STREAM_COMPLETE: the data, until the next transfer starts. */
const uint8_t *console_stream_data(size_t *length, enum console_stream_kind *kind);

void console_stream_get_status(struct console_stream_status *status);

/* Returns whether a transfer was under way. */
bool console_stream_cancel(void);

/* Gives up on a transfer that has been quiet too long. Returns whether it did. */
bool console_stream_expire(int64_t now_ms);

#endif /* CONSOLE_STREAM_H_ */
