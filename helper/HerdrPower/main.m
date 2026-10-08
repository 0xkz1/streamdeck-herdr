// OS の睡眠通知を親プロセスに伝える。Hue の復帰完了を待ってから睡眠を許可する。
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOMessage.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <sys/select.h>
#include <unistd.h>

static io_connect_t rootPort;
static int displayState = -1;

static void emit(const char *event) {
    puts(event);
    fflush(stdout);
}

static void checkDisplay(void) {
    int asleep = CGDisplayIsAsleep(CGMainDisplayID());
    if (asleep == displayState) return;
    displayState = asleep;
    emit(asleep ? "display-sleep" : "display-wake");
}

static void powerChanged(void *ref, io_service_t service, natural_t message, void *argument) {
    switch (message) {
        case kIOMessageCanSystemSleep:
            IOAllowPowerChange(rootPort, (long)argument);
            break;
        case kIOMessageSystemWillSleep: {
            emit("system-sleep");
            // 親が停止処理を終えたら stdin に応答する。応答がなくても睡眠は妨げない。
            fd_set input;
            FD_ZERO(&input);
            FD_SET(STDIN_FILENO, &input);
            struct timeval timeout = { 8, 0 };
            if (select(STDIN_FILENO + 1, &input, NULL, NULL, &timeout) > 0) {
                char reply[32];
                read(STDIN_FILENO, reply, sizeof(reply));
            }
            IOAllowPowerChange(rootPort, (long)argument);
            break;
        }
        case kIOMessageSystemHasPoweredOn:
            checkDisplay();
            emit("system-wake");
            break;
    }
}

static void checkParent(CFRunLoopTimerRef timer, void *info) {
    if (getppid() == 1) exit(0);
    // 画面の復帰通知を取りこぼしても、スリープ扱いを残さない。
    checkDisplay();
}

int main(void) {
    @autoreleasepool {
        IONotificationPortRef port;
        io_object_t notifier;
        rootPort = IORegisterForSystemPower(NULL, &port, powerChanged, &notifier);
        if (!rootPort) return 1;
        CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopCommonModes);
        NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
        [center addObserverForName:NSWorkspaceScreensDidSleepNotification object:nil queue:nil usingBlock:^(NSNotification *note) { displayState = 1; emit("display-sleep"); }];
        [center addObserverForName:NSWorkspaceScreensDidWakeNotification object:nil queue:nil usingBlock:^(NSNotification *note) { displayState = 0; emit("display-wake"); }];
        CFRunLoopTimerRef parentTimer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + 1, 1, 0, 0, checkParent, NULL);
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), parentTimer, kCFRunLoopCommonModes);
        checkDisplay();
        CFRunLoopRun();
    }
    return 0;
}
