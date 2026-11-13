#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cassert>

static NSDictionary *fixtureApp;
static NSArray *fixtureWindows;
static int windowReads;
static bool requestedAccessibility;
static AXError windowError;

static AXUIElementRef fixtureApplication(pid_t pid) {
 return (AXUIElementRef)CFRetain((__bridge CFTypeRef)fixtureApp);
}
static AXError fixtureSetAttribute(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
 if (CFEqual(key, CFSTR("AXManualAccessibility")) && CFEqual(value, kCFBooleanTrue))
  requestedAccessibility = true;
 return kAXErrorSuccess;
}
static AXError fixtureTimeout(AXUIElementRef element, float timeout) {
 return kAXErrorSuccess;
}
static AXError fixtureAttribute(AXUIElementRef element, CFStringRef key, CFTypeRef *value) {
 *value = NULL;
 NSDictionary *attributes = (__bridge NSDictionary *)element;
 if (attributes == fixtureApp && CFEqual(key, kAXWindowsAttribute)) {
  windowReads++;
  if (windowError != kAXErrorSuccess) return windowError;
  // Simulate Electron publishing its tree after the first read.
  NSArray *windows = windowReads == 1 ? @[] : fixtureWindows;
  *value = CFRetain((__bridge CFTypeRef)windows);
  return kAXErrorSuccess;
 }
 id attribute = attributes[(__bridge NSString *)key];
 if (!attribute) return kAXErrorNoValue;
 *value = CFRetain((__bridge CFTypeRef)attribute);
 return kAXErrorSuccess;
}

#define AXUIElementCreateApplication fixtureApplication
#define AXUIElementSetAttributeValue fixtureSetAttribute
#define AXUIElementSetMessagingTimeout fixtureTimeout
#define AXUIElementCopyAttributeValue fixtureAttribute
#define main pointAdapterMain
#include "../native/point-mac.mm"
#undef main

static NSDictionary *fixtureWindow(CGRect frame) {
 CGPoint position = frame.origin;
 CGSize size = frame.size;
 return @{
  (__bridge NSString *)kAXPositionAttribute: CFBridgingRelease(AXValueCreate(kAXValueTypeCGPoint, &position)),
  (__bridge NSString *)kAXSizeAttribute: CFBridgingRelease(AXValueCreate(kAXValueTypeCGSize, &size)),
 };
}
static void expectFailure(void (^operation)(), NSString *message) {
 bool threw = false;
 @try { operation(); }
 @catch (NSException *error) {
  threw = true;
  assert([error.reason containsString:message]);
 }
 assert(threw);
}
int main() { @autoreleasepool {
 fixtureApp = @{ @"fixture": @YES };
 CGRect frame = CGRectMake(-1200, 40, 1100, 800);
 NSDictionary *window = fixtureWindow(frame);
 fixtureWindows = @[window];
 windowError = kAXErrorSuccess;
 NSArray *windows = accessibilityWindows(42);
 assert(requestedAccessibility);
 assert(windowReads == 2);
 assert(windows.count == 1);

 NSDictionary *info = @{
  (__bridge NSString *)kCGWindowBounds: CFBridgingRelease(CGRectCreateDictionaryRepresentation(frame)),
 };
 AXUIElementRef match = matchingWindow(info, windows);
 assert(match && CFEqual(match, (__bridge CFTypeRef)window));
 CFRelease(match);
 assert(matchingWindow(info, @[fixtureWindow(CGRectMake(0, 0, 100, 100))]) == NULL);
 expectFailure(^{ matchingWindow(info, @[window, window]); }, @"Multiple Codex windows match");

 windowReads = 0;
 fixtureWindows = @[];
 expectFailure(^{ accessibilityWindows(42); }, @"Codex is not exposing its accessibility windows");
 windowError = kAXErrorAPIDisabled;
 expectFailure(^{ accessibilityWindows(42); }, @"Allow Laplace in System Settings");
 puts("PASS Point macOS adapter: lazy accessibility, window matching, ambiguity and permission errors");
 return 0;
} }
