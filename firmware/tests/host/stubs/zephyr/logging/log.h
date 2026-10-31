/* Host build: logging goes nowhere. The tests look at the console's replies instead. */
#ifndef HOST_STUB_LOG_H_
#define HOST_STUB_LOG_H_

#define LOG_MODULE_REGISTER(...)
#define LOG_ERR(...) do { } while (0)
#define LOG_WRN(...) do { } while (0)
#define LOG_INF(...) do { } while (0)
#define LOG_DBG(...) do { } while (0)

#endif
