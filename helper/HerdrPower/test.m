#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <string.h>

static bool testAsleep;
static bool testDisplayIsAsleep(CGDirectDisplayID display) {
    return testAsleep;
}

#define CGDisplayIsAsleep testDisplayIsAsleep
#define main powerWatcherMain
#include "main.m"
#undef main
#undef CGDisplayIsAsleep

int main(void) {
    FILE *output = tmpfile();
    int saved = dup(STDOUT_FILENO);
    dup2(fileno(output), STDOUT_FILENO);
    testAsleep = true;
    checkParent(NULL, NULL);
    checkParent(NULL, NULL);
    // No workspace wake notification arrives; the timer must notice the wake.
    testAsleep = false;
    checkParent(NULL, NULL);
    checkParent(NULL, NULL);
    testAsleep = true;
    checkParent(NULL, NULL);
    testAsleep = false;
    powerChanged(NULL, 0, kIOMessageSystemHasPoweredOn, NULL);
    fflush(stdout);
    rewind(output);
    char actual[256] = {0};
    fread(actual, 1, sizeof(actual) - 1, output);
    dup2(saved, STDOUT_FILENO);
    close(saved);
    fclose(output);
    const char *expected = "display-sleep\ndisplay-wake\ndisplay-sleep\ndisplay-wake\nsystem-wake\n";
    if (strcmp(actual, expected) != 0) {
        fprintf(stderr, "Missed display notification was not recovered. Events:\n%s", actual);
        return 1;
    }
    puts("PASS: missed display notifications recover; unchanged states emit once; system wake is preserved");
    return 0;
}
