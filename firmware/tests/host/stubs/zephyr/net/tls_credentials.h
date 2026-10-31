/* Host build: the TLS credential store as firmware/app/src/factory.c uses it. */
#ifndef HOST_STUB_TLS_CREDENTIALS_H_
#define HOST_STUB_TLS_CREDENTIALS_H_

#include <stddef.h>

typedef int sec_tag_t;

enum tls_credential_type {
	TLS_CREDENTIAL_NONE,
	TLS_CREDENTIAL_CA_CERTIFICATE,
	TLS_CREDENTIAL_PUBLIC_CERTIFICATE,
	TLS_CREDENTIAL_PRIVATE_KEY,
};

int tls_credential_get(sec_tag_t tag, enum tls_credential_type type, void *cred, size_t *len);
int tls_credential_delete(sec_tag_t tag, enum tls_credential_type type);

#endif
