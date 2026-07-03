/* 小助手：让 R worker 能 reap 自己 spawn 的子进程，避免僵尸任务卡死 */
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

void reap_pid(int *pid, int *status) {
    int st;
    pid_t p = (pid_t)*pid;
    pid_t r = waitpid(p, &st, WNOHANG);
    if (r == 0) {
        *status = -1;          /* 还在跑 */
    } else if (r < 0) {
        *status = -2;          /* 出错或已无该子进程 */
    } else if (WIFEXITED(st)) {
        *status = WEXITSTATUS(st); /* 正常退出，返回 exit code */
    } else if (WIFSIGNALED(st)) {
        *status = -100 - WTERMSIG(st); /* 被信号终止 */
    } else {
        *status = -3;          /* 其他状态 */
    }
}
