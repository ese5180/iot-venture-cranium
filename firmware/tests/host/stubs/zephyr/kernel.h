/*
 * Host build: the little of the kernel's header that the firmware's code uses. Functions are
 * only declared here: a test that compiles code which needs them defines them, and so
 * decides when a wait ends and what happens during a sleep.
 */
#ifndef HOST_STUB_KERNEL_H_
#define HOST_STUB_KERNEL_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <zephyr/toolchain.h>

typedef int k_timeout_t;
#define K_NO_WAIT     0
#define K_FOREVER     (-1)
#define K_MSEC(ms)    (ms)
#define K_SECONDS(s)  ((s) * 1000)
#define MSEC_PER_SEC  1000

/* One thread: a lock has nothing to do. */
struct k_spinlock {
	int unused;
};
typedef int k_spinlock_key_t;
#define k_spin_lock(lock)        ((void)(lock), (k_spinlock_key_t)0)
#define k_spin_unlock(lock, key) ((void)(lock), (void)(key))

struct k_sem {
	int count;
};
#define K_SEM_DEFINE(name, initial, limit) struct k_sem name = { initial }
int k_sem_take(struct k_sem *sem, k_timeout_t timeout);
void k_sem_give(struct k_sem *sem);

struct k_thread {
	int unused;
};
#define K_THREAD_STACK_DEFINE(name, size) char name[size]
#define K_THREAD_STACK_SIZEOF(stack)      sizeof(stack)
#define K_PRIO_PREEMPT(priority)          (priority)
void k_thread_create(struct k_thread *thread, char *stack, size_t size,
		     void (*entry)(void *, void *, void *), void *a, void *b, void *c, int priority,
		     int options, k_timeout_t delay);
int k_thread_name_set(struct k_thread *thread, const char *name);

int32_t k_msleep(int32_t ms);
void k_busy_wait(uint32_t us);
int64_t k_uptime_get(void);
void k_oops(void);

struct k_msgq {
	size_t message_size;
	unsigned int capacity;
	unsigned int used;
	char *buffer;
};
#define K_MSGQ_DEFINE(name, size, count, align)                                              \
	static char name##_buffer[(size) * (count)];                                         \
	static struct k_msgq name = { (size), (count), 0, name##_buffer }
int k_msgq_put(struct k_msgq *queue, const void *message, k_timeout_t timeout);
int k_msgq_get(struct k_msgq *queue, void *message, k_timeout_t timeout);

struct k_timer {
	void (*expiry)(struct k_timer *timer);
};
#define K_TIMER_DEFINE(name, on_expiry, on_stop) static struct k_timer name = { on_expiry }
void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period);

typedef long atomic_t;
typedef long atomic_val_t;
#define ATOMIC_INIT(value) (value)

static inline atomic_val_t atomic_get(const atomic_t *target)
{
	return *target;
}

static inline atomic_val_t atomic_set(atomic_t *target, atomic_val_t value)
{
	atomic_val_t old = *target;

	*target = value;
	return old;
}

static inline bool atomic_cas(atomic_t *target, atomic_val_t expected, atomic_val_t value)
{
	if (*target != expected) {
		return false;
	}

	*target = value;
	return true;
}

static inline atomic_val_t atomic_inc(atomic_t *target)
{
	return (*target)++;
}

static inline atomic_val_t atomic_or(atomic_t *target, atomic_val_t value)
{
	atomic_val_t old = *target;

	*target = old | value;
	return old;
}

static inline atomic_val_t atomic_and(atomic_t *target, atomic_val_t value)
{
	atomic_val_t old = *target;

	*target = old & value;
	return old;
}

#endif
