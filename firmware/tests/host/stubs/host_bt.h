/*
 * Host build: the Bluetooth host, MCUmgr, the bootloader's API and the flash map, as far as
 * bt_ota.c uses them. Functions are only declared here, and test_bt_ota.c defines them and
 * plays the part of the phone and the bootloader.
 *
 * The numbers that have to agree with the real thing are checked in bt_ota.c against the real
 * headers, at build time.
 */
#ifndef HOST_STUB_BT_H_
#define HOST_STUB_BT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/kernel.h>

#define DT_NODELABEL(label) 0

/* ---- Bluetooth ------------------------------------------------------------------ */

struct bt_conn {
	int unused;
};

struct bt_data {
	uint8_t type;
	uint8_t data_len;
	const uint8_t *data;
};

#define BT_DATA_BYTES(_type, ...)                                                            \
	{ .type = (_type), .data_len = sizeof((const uint8_t[]){ __VA_ARGS__ }),             \
	  .data = (const uint8_t[]){ __VA_ARGS__ } }
#define BT_DATA_FLAGS         1
#define BT_DATA_UUID128_ALL   7
#define BT_DATA_NAME_COMPLETE 9
#define BT_LE_AD_GENERAL      2
#define BT_LE_AD_NO_BREDR     4
#define SMP_BT_SVC_UUID_VAL   0x84, 0xaa, 0x60, 0x74, 0x52, 0x8a, 0x8b, 0x86, 0xd3, 0x4c, 0xb7,  \
			      0x1d, 0x1d, 0xdc, 0x53, 0x8d
#define BT_LE_ADV_CONN_FAST_1 NULL

typedef void (*bt_ready_cb_t)(int err);
int bt_enable(bt_ready_cb_t cb);
int bt_le_adv_start(const void *param, const struct bt_data *ad, size_t ad_len,
		    const struct bt_data *sd, size_t sd_len);
int bt_le_adv_stop(void);
int bt_rand(void *buf, size_t len);

typedef enum {
	BT_SECURITY_L1 = 1,
	BT_SECURITY_L2,
	BT_SECURITY_L3,
	BT_SECURITY_L4,
} bt_security_t;

enum bt_security_err {
	BT_SECURITY_ERR_SUCCESS,
	BT_SECURITY_ERR_AUTH_FAIL,
	BT_SECURITY_ERR_PAIR_NOT_ALLOWED,
};

enum bt_security_flag {
	BT_SECURITY_FLAG_SC = 1,
};

struct bt_conn_info {
	struct {
		uint8_t enc_key_size;
		enum bt_security_flag flags;
	} security;
};

struct bt_conn_cb {
	void (*connected)(struct bt_conn *conn, uint8_t err);
	void (*disconnected)(struct bt_conn *conn, uint8_t reason);
	void (*security_changed)(struct bt_conn *conn, bt_security_t level,
				 enum bt_security_err err);
};
#define BT_CONN_CB_DEFINE(name) static const struct bt_conn_cb name

struct bt_conn_pairing_feat {
	uint8_t auth_req;
};

struct bt_conn_auth_cb {
	enum bt_security_err (*pairing_accept)(struct bt_conn *conn,
					       const struct bt_conn_pairing_feat *const feat);
	void (*passkey_display)(struct bt_conn *conn, unsigned int passkey);
	void (*cancel)(struct bt_conn *conn);
};

struct bt_conn_auth_info_cb {
	void (*pairing_failed)(struct bt_conn *conn, enum bt_security_err reason);
};

#define BT_HCI_ERR_AUTH_FAIL              0x05
#define BT_HCI_ERR_REMOTE_USER_TERM_CONN  0x13
#define BT_CONN_TYPE_LE                   1

int bt_conn_auth_cb_register(const struct bt_conn_auth_cb *cb);
int bt_conn_auth_info_cb_register(struct bt_conn_auth_info_cb *cb);
int bt_conn_disconnect(struct bt_conn *conn, uint8_t reason);
int bt_conn_set_security(struct bt_conn *conn, bt_security_t level);
int bt_conn_get_info(const struct bt_conn *conn, struct bt_conn_info *info);
void bt_conn_foreach(int type, void (*func)(struct bt_conn *conn, void *data), void *data);

/* ---- MCUmgr --------------------------------------------------------------------- */

#define MGMT_OP_READ         0
#define MGMT_OP_WRITE        2
#define MGMT_GROUP_ID_IMAGE  1
#define IMG_MGMT_ID_STATE    0
#define IMG_MGMT_ID_UPLOAD   1
#define IMG_MGMT_ID_ERASE    5
#define IMAGE_MAGIC          0x96f3b83dU
#define IMAGE_HEADER_SIZE    32
#define MGMT_ERR_EOK           0
#define MGMT_ERR_EBADSTATE     6
#define MGMT_ERR_EACCESSDENIED 11

enum mgmt_cb_return {
	MGMT_CB_OK,
	MGMT_CB_ERROR_RC,
};

/* As MCUmgr has them: a group in the upper half, a bit for each event in the lower. */
#define MGMT_EVT_GRP_SMP                 1U
#define MGMT_EVT_GRP_IMG                 3U
#define MGMT_DEF_EVT_OP_ID(group, id)    (((group) << 16) | (1U << (id)))
#define MGMT_EVT_GET_GROUP(event)        (((event) >> 16) & 0xffffU)
#define MGMT_EVT_GET_ID(event)           ((event) & 0xffffU)
#define MGMT_EVT_OP_CMD_RECV             MGMT_DEF_EVT_OP_ID(MGMT_EVT_GRP_SMP, 0)
#define MGMT_EVT_OP_CMD_DONE             MGMT_DEF_EVT_OP_ID(MGMT_EVT_GRP_SMP, 2)
#define MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK   MGMT_DEF_EVT_OP_ID(MGMT_EVT_GRP_IMG, 0)
#define MGMT_EVT_OP_IMG_MGMT_DFU_PENDING MGMT_DEF_EVT_OP_ID(MGMT_EVT_GRP_IMG, 3)

typedef enum mgmt_cb_return (*mgmt_cb)(uint32_t event, enum mgmt_cb_return prev_status,
				       int32_t *rc, uint16_t *group, bool *abort_more, void *data,
				       size_t data_size);

struct mgmt_callback {
	mgmt_cb callback;
	uint32_t event_id;
};

void mgmt_callback_register(struct mgmt_callback *callback);

struct mgmt_evt_op_cmd_arg {
	uint16_t group;
	uint16_t id;
	union {
		uint8_t op;
		int err;
	};
};

struct img_mgmt_upload_action {
	unsigned long long size;
};

struct img_mgmt_upload_req {
	uint32_t image;
	size_t off;
	struct {
		const uint8_t *value;
		size_t len;
	} img_data;
};

struct img_mgmt_upload_check {
	struct img_mgmt_upload_action *action;
	struct img_mgmt_upload_req *req;
};

struct image_version {
	uint8_t iv_major;
};

void img_mgmt_reset_upload(void);
int img_mgmt_read_info(int image_slot, struct image_version *ver, uint8_t *hash, uint32_t *flags);

/* ---- the bootloader's API and the flash map ----------------------------------------- */

#define PARTITION_ID(label)   1
#define PARTITION_SIZE(label) 0xe4000
#define BOOT_SWAP_TYPE_NONE   1
#define BOOT_SWAP_TYPE_TEST   2
#define BOOT_SWAP_TYPE_REVERT 4
#define BOOT_UPGRADE_TEST     0
#define BOOT_UPGRADE_PERMANENT 1

struct mcuboot_img_header {
	uint32_t mcuboot_version;
	union {
		struct {
			uint32_t image_size;
			struct {
				uint8_t major;
				uint8_t minor;
				uint16_t revision;
				uint32_t build_num;
			} sem_ver;
		} v1;
	} h;
};

int boot_read_bank_header(uint8_t area_id, struct mcuboot_img_header *header, size_t header_size);
int mcuboot_swap_type_multi(int image_index);
int boot_request_upgrade_multi(int image_index, int permanent);
int boot_erase_img_bank(uint8_t area_id);
int boot_write_img_confirmed(void);
bool boot_is_img_confirmed(void);

struct flash_area {
	uint8_t fa_id;
	size_t fa_size;
};

int flash_area_open(uint8_t id, const struct flash_area **area);
int flash_area_read(const struct flash_area *area, long offset, void *data, size_t length);
void flash_area_close(const struct flash_area *area);

#endif
