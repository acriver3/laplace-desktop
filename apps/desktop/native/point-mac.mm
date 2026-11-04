#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static pid_t targetPid;
static CGWindowID targetId;
static NSRunningApplication *targetApp;
static id attr(AXUIElementRef element, CFStringRef key) {
 CFTypeRef value = NULL;
 if (AXUIElementCopyAttributeValue(element, key, &value) != kAXErrorSuccess) return nil;
 return CFBridgingRelease(value);
}
static void fail(NSString *message) { @throw [NSException exceptionWithName:@"Point" reason:message userInfo:nil]; }
static bool codex(NSRunningApplication *app) { return [@[@"com.openai.codex", @"com.openai.chatgpt"] containsObject:app.bundleIdentifier]; }
static NSString *version(NSRunningApplication *app) {
 NSDictionary *info = [NSBundle bundleWithURL:app.bundleURL].infoDictionary;
 return [NSString stringWithFormat:@"%@/%@/%@", app.bundleIdentifier, info[@"CFBundleShortVersionString"] ?: @"unknown", info[@"CFBundleVersion"] ?: @"unknown"];
}
static NSArray *windowInfo() { return CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID)); }
static NSDictionary *currentInfo() {
 for (NSDictionary *window in windowInfo()) if ([window[(id)kCGWindowNumber] unsignedIntValue] == targetId && [window[(id)kCGWindowOwnerPID] intValue] == targetPid) return window;
 fail(@"The Codex window is unavailable. Your snip is retained."); return nil;
}
static AXUIElementRef targetWindow() {
 targetApp = [NSRunningApplication runningApplicationWithProcessIdentifier:targetPid];
 if (!codex(targetApp)) fail(@"The Codex destination changed.");
 NSDictionary *info = currentInfo(); CGRect bounds; CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &bounds);
 AXUIElementRef app = AXUIElementCreateApplication(targetPid);
 NSArray *windows = attr(app, kAXWindowsAttribute); CFRelease(app);
 AXUIElementRef found = NULL;
 for (id object in windows) {
  AXUIElementRef w = (__bridge AXUIElementRef)object; CGPoint p; CGSize s;
  id position = attr(w, kAXPositionAttribute), size = attr(w, kAXSizeAttribute);
  if (!position || !size || !AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &p) || !AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &s)) continue;
  if (fabs(p.x-bounds.origin.x)<2 && fabs(p.y-bounds.origin.y)<2 && fabs(s.width-bounds.size.width)<2 && fabs(s.height-bounds.size.height)<2) {
   if (found) { CFRelease(found); fail(@"Multiple Codex windows match. Select the intended window and retry."); }
   found = (AXUIElementRef)CFRetain(w);
  }
 }
 if (!found) fail(@"Codex accessibility is unavailable. Allow Laplace in System Settings > Privacy & Security > Accessibility.");
 return found;
}
static void foreground() {
 if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != targetPid) fail(@"Codex lost focus. Your snip is retained.");
 AXUIElementRef w=targetWindow(), app=AXUIElementCreateApplication(targetPid);
 id focused=attr(app,kAXFocusedWindowAttribute);
 bool matches=focused && CFEqual(w,(__bridge CFTypeRef)focused);CFRelease(w);CFRelease(app);
 if(!matches)fail(@"The selected Codex window is no longer focused.");
}
static void activate() {
 AXUIElementRef w=targetWindow();
 AXUIElementSetAttributeValue(w,kAXMinimizedAttribute,kCFBooleanFalse);
 [targetApp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
 AXUIElementPerformAction(w,kAXRaiseAction);CFRelease(w);
 for(int n=0;n<20&&NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier!=targetPid;n++)[NSThread sleepForTimeInterval:.05];
 foreground();
}
static void key(CGKeyCode code, CGEventFlags flags) {
 foreground(); CGEventRef down=CGEventCreateKeyboardEvent(NULL,code,true), up=CGEventCreateKeyboardEvent(NULL,code,false);
 CGEventSetFlags(down,flags);CGEventSetFlags(up,flags);CGEventPost(kCGHIDEventTap,down);CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
static NSString *name(id object) {
 AXUIElementRef e=(__bridge AXUIElementRef)object;
 for (NSString *keyName in @[@"AXTitle",@"AXDescription",@"AXHelp",@"AXPlaceholderValue"]) { id value=attr(e,(__bridge CFStringRef)keyName);if([value isKindOfClass:NSString.class]&&[value length])return value; }
 return @"";
}
static NSString *role(id object) { return attr((__bridge AXUIElementRef)object,kAXRoleAttribute) ?: @""; }
static bool has(NSString *s, NSString *part) { return [s rangeOfString:part options:NSCaseInsensitiveSearch].location!=NSNotFound; }
static bool edit(id e) { return [@[@"AXTextField",@"AXTextArea"] containsObject:role(e)]; }
static bool composer(id e) { NSString *s=name(e);return edit(e)&&([s isEqual:@"Work with Codex"]||has(s,@"Ask anything")||has(s,@"Ask Codex")||has(s,@"Message Codex")||has(s,@"Follow up")||has(s,@"Describe a task")||has(s,@"Message ChatGPT")); }
static bool editor(id e) {NSString *s=name(e);return edit(e)&&([s isEqual:@"Comment"]||has(s,@"Add a comment")||has(s,@"Write a comment"));}
static bool stage(id e) {return [role(e) isEqual:@"AXButton"]&&[@[@"Add to chat",@"Add to context"] containsObject:name(e)];}
static NSArray *elements() {
 AXUIElementRef w=targetWindow();NSMutableArray *queue=[NSMutableArray arrayWithObject:CFBridgingRelease(w)],*result=[NSMutableArray array];
 for(NSUInteger index=0;index<queue.count;index++) {
  if(queue.count>30000)fail(@"Codex returned too many controls.");id e=queue[index];
  id enabled=attr((__bridge AXUIElementRef)e,kAXEnabledAttribute);
  if(!enabled||[enabled boolValue])[result addObject:e];
  NSArray *children=attr((__bridge AXUIElementRef)e,kAXChildrenAttribute);if(children)[queue addObjectsFromArray:children];
 }
 return result;
}
static id unique(bool (^matches)(id)) {id found=nil;for(id e in elements())if(matches(e)){if(found)fail(@"Multiple Codex controls match. Select the intended chat and retry.");found=e;}if(!found)fail(@"Codex does not expose the required control. Use Copy snip to paste manually.");return found;}
static void click(id object) {
 foreground();AXUIElementRef e=(__bridge AXUIElementRef)object;CGPoint p;CGSize s;id position=attr(e,kAXPositionAttribute),size=attr(e,kAXSizeAttribute);
 if(!position||!size||!AXValueGetValue((__bridge AXValueRef)position,kAXValueTypeCGPoint,&p)||!AXValueGetValue((__bridge AXValueRef)size,kAXValueTypeCGSize,&s)||s.width<=0||s.height<=0)fail(@"Codex control is not visible.");
 CGPoint center=CGPointMake(p.x+s.width/2,p.y+s.height/2);
 CGEventRef down=CGEventCreateMouseEvent(NULL,kCGEventLeftMouseDown,center,kCGMouseButtonLeft),up=CGEventCreateMouseEvent(NULL,kCGEventLeftMouseUp,center,kCGMouseButtonLeft);
 CGEventPost(kCGHIDEventTap,down);CGEventPost(kCGHIDEventTap,up);CFRelease(down);CFRelease(up);
}
static id focused() {AXUIElementRef app=AXUIElementCreateApplication(targetPid);id e=attr(app,kAXFocusedUIElementAttribute);CFRelease(app);return e;}
static void focusComposer() {activate();id e=unique(^bool(id x){return composer(x);});if(AXUIElementSetAttributeValue((__bridge AXUIElementRef)e,kAXFocusedAttribute,kCFBooleanTrue)!=kAXErrorSuccess)fail(@"The Codex composer could not be focused.");id f=focused();if(!f||!CFEqual((__bridge CFTypeRef)e,(__bridge CFTypeRef)f))fail(@"The Codex composer could not be focused.");}
static void output(NSDictionary *value) {NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];fwrite(data.bytes,1,data.length,stdout);}
int main(int argc,const char **argv) { @autoreleasepool { @try {
 if(argc<2)fail(@"Missing Point operation.");NSString *operation=@(argv[1]);
 if(!AXIsProcessTrusted())fail(@"Allow Laplace in System Settings > Privacy & Security > Accessibility, then retry.");
 if([operation isEqual:@"identify"]) {
  for(NSDictionary *w in windowInfo()) {if([w[(id)kCGWindowLayer] intValue]!=0)continue;pid_t pid=[w[(id)kCGWindowOwnerPID] intValue];NSRunningApplication *app=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];if(!codex(app))continue;
   output(@{@"window":[w[(id)kCGWindowNumber] stringValue],@"pid":@(pid),@"version":version(app)});return 0;
  } fail(@"Open a Codex desktop chat, then retry your snip.");
 }
 if(argc!=4)fail(@"Invalid Point operation.");targetId=(CGWindowID)strtoul(argv[2],NULL,10);targetPid=(pid_t)strtol(argv[3],NULL,10);
 AXUIElementRef w=targetWindow();CFRelease(w);
 if([operation isEqual:@"observe"]) {int composers=0,editors=0,attachments=0,annotations=0,stages=0;for(id e in elements()){composers+=composer(e);editors+=editor(e);stages+=stage(e);NSString *s=name(e);if([role(e) isEqual:@"AXButton"]&&(has(s,@"Remove image")||has(s,@"Remove attachment")||has(s,@"Remove file")))attachments++;if([role(e) isEqual:@"AXButton"]&&has(s,@"Laplace Point")&&has(s,@"annotation"))annotations++;}output(@{@"composer":@(composers==1),@"editor":@(editors>0),@"attachments":@(attachments),@"annotations":@(annotations),@"stage":@(stages==1)});return 0;}
 if([operation isEqual:@"copy-link"]){activate();key(37,kCGEventFlagMaskCommand|kCGEventFlagMaskAlternate);}
 else if([operation isEqual:@"open-tab"]){activate();key(17,kCGEventFlagMaskCommand);}
 else if([operation isEqual:@"navigate"]){foreground();NSString *url=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];NSRegularExpression *pattern=[NSRegularExpression regularExpressionWithPattern:@"^http://127\\.0\\.0\\.1:[0-9]+/capture/[a-f0-9]{64}/$" options:0 error:nil];if(!url||[pattern numberOfMatchesInString:url options:0 range:NSMakeRange(0,url.length)]!=1)fail(@"Invalid Point page URL.");id e=focused();if(!e||!edit(e)||!(has(name(e),@"address")||has(name(e),@"URL")||has(name(e),@"Search or enter")))fail(@"The browser address field is not focused.");key(9,kCGEventFlagMaskCommand);key(36,0);}
 else if([operation isEqual:@"annotate"]){activate();click(unique(^bool(id e){return [role(e) isEqual:@"AXButton"]&&[name(e) isEqual:@"Annotate this snip"]; }));}
 else if([operation isEqual:@"stage"]){activate();click(unique(^bool(id e){return stage(e);}));}
 else if([operation isEqual:@"focus-composer"])focusComposer();
 else if([operation isEqual:@"focus-annotation"]){activate();id e=unique(^bool(id x){return editor(x);});if(AXUIElementSetAttributeValue((__bridge AXUIElementRef)e,kAXFocusedAttribute,kCFBooleanTrue)!=kAXErrorSuccess)fail(@"Could not focus the annotation comment.");id f=focused();if(!f||!CFEqual((__bridge CFTypeRef)e,(__bridge CFTypeRef)f))fail(@"Annotation comment focus could not be verified.");}
 else if([operation isEqual:@"paste-image"]){foreground();id e=unique(^bool(id x){return composer(x);});id f=focused();if(!f||!CFEqual((__bridge CFTypeRef)e,(__bridge CFTypeRef)f))fail(@"The Codex composer lost focus.");if(![NSPasteboard.generalPasteboard availableTypeFromArray:@[NSPasteboardTypePNG,NSPasteboardTypeTIFF]])fail(@"Screenshot clipboard is unavailable.");key(125,kCGEventFlagMaskCommand);key(9,kCGEventFlagMaskCommand);}
 else fail(@"Unsupported Point operation.");output(@{@"ok":@YES});return 0;
 } @catch(NSException *e) {output(@{@"error":e.reason ?: @"Codex handoff failed."});return 1;} } }
