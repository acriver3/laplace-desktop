#define UNICODE
#define _UNICODE
#include <windows.h>
#include <uiautomation.h>
#include <appmodel.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <iostream>
#include <regex>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static HWND target;
static DWORD targetPid;
static ComPtr<IUIAutomation> automation;
static std::wstring lower(std::wstring s) { for (auto &c:s) c=towlower(c); return s; }
static bool contains(const std::wstring &s, const wchar_t *v) { return lower(s).find(lower(v))!=std::wstring::npos; }
static std::string utf8(const std::wstring &s) { int n=WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),nullptr,0,nullptr,nullptr); std::string out(n,0); WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),out.data(),n,nullptr,nullptr); return out; }
static std::string quote(const std::wstring &s) { std::string out="\""; for(unsigned char c:utf8(s)) { if(c=='"'||c=='\\') out+='\\'; if(c>=32) out+=c; } return out+'"'; }
static std::wstring identity(DWORD pid) {
 HANDLE p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid); if(!p)return L"";
 UINT32 length=0; GetPackageFullName(p,&length,nullptr); std::wstring package(length,L'\0');
 if(length&&GetPackageFullName(p,&length,package.data())==ERROR_SUCCESS) { CloseHandle(p); package.resize(wcslen(package.c_str())); return package.rfind(L"OpenAI.Codex_",0)==0?package:L""; }
 wchar_t path[32768]; DWORD size=32768; bool ok=QueryFullProcessImageNameW(p,0,path,&size); CloseHandle(p); if(!ok)return L"";
 std::wstring filename=lower(path);
 if(filename.find(L"\\openai\\")==std::wstring::npos || (filename.find(L"\\codex.exe")==std::wstring::npos && filename.find(L"\\chatgpt.exe")==std::wstring::npos))return L"";
 DWORD unused=0; DWORD bytes=GetFileVersionInfoSizeW(path,&unused); if(!bytes)return L"";
 std::vector<BYTE> data(bytes); if(!GetFileVersionInfoW(path,0,bytes,data.data()))return L"";
 VS_FIXEDFILEINFO *info=nullptr; UINT len=0; if(!VerQueryValueW(data.data(),L"\\",(void**)&info,&len)||!info)return L"";
 return std::to_wstring(HIWORD(info->dwFileVersionMS))+L"."+std::to_wstring(LOWORD(info->dwFileVersionMS))+L"."+std::to_wstring(HIWORD(info->dwFileVersionLS))+L"."+std::to_wstring(LOWORD(info->dwFileVersionLS));
}
static BOOL CALLBACK choose(HWND h,LPARAM) {
 if(!IsWindowVisible(h)||GetWindow(h,GW_OWNER))return TRUE;
 DWORD pid=0; GetWindowThreadProcessId(h,&pid);
 if(identity(pid).empty())return TRUE;
 target=h; targetPid=pid; return FALSE;
}
static void valid() { DWORD pid=0; if(!IsWindow(target))throw std::runtime_error("The Codex window closed. Your snip is retained."); GetWindowThreadProcessId(target,&pid); if(pid!=targetPid||identity(pid).empty())throw std::runtime_error("The Codex destination changed."); }
static HWND annotationWindow() {
 valid();std::vector<HWND> found;
 EnumWindows([](HWND h,LPARAM data)->BOOL{DWORD pid=0;GetWindowThreadProcessId(h,&pid);wchar_t title[80]={};GetWindowTextW(h,title,80);if(pid==targetPid&&IsWindowVisible(h)&&GetWindow(h,GW_OWNER)==target&&std::wstring(title)==L"Browser comment")((std::vector<HWND>*)data)->push_back(h);return TRUE;},(LPARAM)&found);
 if(found.size()>1)throw std::runtime_error("Multiple Codex comment windows are open. Finish the existing comment first.");
 return found.empty()?target:found[0];
}
static void foreground(HWND window=target) { valid();auto active=GetForegroundWindow();if(active!=window&&!(window!=target&&active==target&&annotationWindow()==window))throw std::runtime_error("Codex lost focus. Your snip is retained."); }
static void activate(HWND window=target) {
 valid();if(IsIconic(window))ShowWindow(window,SW_RESTORE);
 // Codex's owned comment surface can be a non-activating window. Its parent
 // remains foreground while the text field inside the popup owns UIA focus.
 HWND activeTarget=target;
 if(GetForegroundWindow()==window||GetForegroundWindow()==activeTarget)return;
 SetForegroundWindow(activeTarget);
 if(GetForegroundWindow()!=activeTarget){ComPtr<IUIAutomationElement> root;if(SUCCEEDED(automation->ElementFromHandle(activeTarget,&root)))root->SetFocus();}
 for(int n=0;n<20&&GetForegroundWindow()!=activeTarget;n++)Sleep(50);foreground(window);
}
static void chord(std::initializer_list<WORD> keys,HWND window=target) {
 foreground(window); std::vector<INPUT> inputs; for(WORD key:keys){ INPUT i={};i.type=INPUT_KEYBOARD;i.ki.wVk=key;inputs.push_back(i); }
 auto copy=inputs; for(auto it=copy.rbegin();it!=copy.rend();++it){INPUT i=*it;i.ki.dwFlags=KEYEVENTF_KEYUP;inputs.push_back(i);}
 if(SendInput((UINT)inputs.size(),inputs.data(),sizeof(INPUT))!=inputs.size())throw std::runtime_error("Windows blocked Codex input. Run both applications at the same privilege level.");
}
static std::wstring name(IUIAutomationElement *e) { BSTR v=nullptr; if(FAILED(e->get_CachedName(&v)))e->get_CurrentName(&v); std::wstring s=v?v:L""; SysFreeString(v); return s; }
static CONTROLTYPEID role(IUIAutomationElement *e){CONTROLTYPEID r=0;if(FAILED(e->get_CachedControlType(&r)))e->get_CurrentControlType(&r);return r;}
static std::vector<ComPtr<IUIAutomationElement>> elements(HWND window=target) {
 valid(); ComPtr<IUIAutomationElement> root; if(FAILED(automation->ElementFromHandle(window,&root)))throw std::runtime_error("Codex accessibility is unavailable.");
 ComPtr<IUIAutomationCondition> condition; automation->CreateTrueCondition(&condition);
 // Fetch properties in one cross-process traversal, rather than hundreds of COM calls.
 ComPtr<IUIAutomationCacheRequest> cache; automation->CreateCacheRequest(&cache);
 for(auto property:{UIA_NamePropertyId,UIA_ControlTypePropertyId,UIA_IsOffscreenPropertyId,UIA_IsEnabledPropertyId})cache->AddProperty(property);
 ComPtr<IUIAutomationElementArray> array; if(FAILED(root->FindAllBuildCache(TreeScope_Descendants,condition.Get(),cache.Get(),&array)))throw std::runtime_error("Codex controls are unavailable.");
 int count=0;array->get_Length(&count); if(count>30000)throw std::runtime_error("Codex returned too many controls.");
 std::vector<ComPtr<IUIAutomationElement>> result;
 for(int i=0;i<count;i++){ComPtr<IUIAutomationElement> e;array->GetElement(i,&e);BOOL off=TRUE,enabled=FALSE;e->get_CachedIsOffscreen(&off);e->get_CachedIsEnabled(&enabled);if(!off&&enabled)result.push_back(e);}
 return result;
}
static bool composer(IUIAutomationElement *e) { if(role(e)!=UIA_EditControlTypeId)return false; auto s=name(e); return s==L"Work with Codex"||contains(s,L"Ask anything")||contains(s,L"Ask Codex")||contains(s,L"Message Codex")||contains(s,L"Follow up")||contains(s,L"Describe a task")||contains(s,L"Message ChatGPT"); }
static bool editor(IUIAutomationElement *e) { if(role(e)!=UIA_EditControlTypeId)return false; auto s=name(e); return s==L"Comment"||contains(s,L"Add a comment")||contains(s,L"Write a comment"); }
static bool address(IUIAutomationElement *e) {auto r=role(e);auto s=name(e);return (r==UIA_EditControlTypeId||r==UIA_ComboBoxControlTypeId)&&(s==L"Search or enter a URL"||contains(s,L"address")||contains(s,L"URL"));}
// The qualified Windows build saves directly to the draft. No separate staging
// control is qualified; never click a similarly named button inside a webpage.
static bool stage(IUIAutomationElement *) { return false; }
static int draftAnnotationCount(IUIAutomationElement *remove) {
 // Count only the draft chip which has a removal control, never annotation
 // counts in submitted messages or browser toolbars.
 ComPtr<IUIAutomationTreeWalker> walker;automation->get_ControlViewWalker(&walker);
 ComPtr<IUIAutomationElement> node=remove;ComPtr<IUIAutomationCondition> all;automation->CreateTrueCondition(&all);
 ComPtr<IUIAutomationCacheRequest> cache;automation->CreateCacheRequest(&cache);cache->AddProperty(UIA_NamePropertyId);cache->AddProperty(UIA_ControlTypePropertyId);
 for(int depth=0;depth<3;depth++){
  ComPtr<IUIAutomationElement> parent;if(FAILED(walker->GetParentElement(node.Get(),&parent))||!parent)break;node=parent;
  ComPtr<IUIAutomationElementArray> children;if(FAILED(parent->FindAllBuildCache(TreeScope_Descendants,all.Get(),cache.Get(),&children)))break;
  int length=0;children->get_Length(&length);if(length>100)break;int count=0,matches=0,removals=0;
  for(int n=0;n<length;n++){ComPtr<IUIAutomationElement> e;children->GetElement(n,&e);if(role(e.Get())!=UIA_ButtonControlTypeId)continue;auto s=name(e.Get());removals+=s==L"Remove annotations attachment";std::wsmatch match;if(std::regex_match(s,match,std::wregex(L"^([0-9]{1,4}) annotations?(?: .*)?$"))){count=std::stoi(match[1]);matches++;}}
  if(matches==1&&removals==1)return count;
  if(matches>1||removals>1)break;
 }
 return 0;
}
template<class Predicate> static ComPtr<IUIAutomationElement> unique(Predicate match,HWND window=target) {
 ComPtr<IUIAutomationElement> found; for(auto e:elements(window))if(match(e.Get())){if(found)throw std::runtime_error("Codex exposes multiple matching controls. Select the intended chat and retry.");found=e;}
 if(!found)throw std::runtime_error("Codex does not expose the required accessible control. Use Copy snip to paste manually.");return found;
}
static void click(IUIAutomationElement *e,HWND window=target) {
 foreground(window);RECT r; if(FAILED(e->get_CurrentBoundingRectangle(&r))||r.right<=r.left||r.bottom<=r.top)throw std::runtime_error("Codex control is not visible.");
 POINT p={(r.left+r.right)/2,(r.top+r.bottom)/2}; HWND hit=WindowFromPoint(p);if(GetAncestor(hit,GA_ROOT)!=window)throw std::runtime_error("Another window covers Codex.");
 SetCursorPos(p.x,p.y);INPUT a[2]={};a[0].type=a[1].type=INPUT_MOUSE;a[0].mi.dwFlags=MOUSEEVENTF_LEFTDOWN;a[1].mi.dwFlags=MOUSEEVENTF_LEFTUP;if(SendInput(2,a,sizeof(INPUT))!=2)throw std::runtime_error("Codex input was blocked.");
}
// Chromium may focus a text descendant rather than the outer contenteditable.
// Check the current UIA tree, never a cached focus property or just the window.
static bool containsFocus(IUIAutomationElement *container) {
 ComPtr<IUIAutomationElement> focused; if(FAILED(automation->GetFocusedElement(&focused))||!focused)return false;
 ComPtr<IUIAutomationTreeWalker> walker; if(FAILED(automation->get_RawViewWalker(&walker)))return false;
 for(int depth=0;focused&&depth<24;depth++) {
  BOOL same=FALSE; if(SUCCEEDED(automation->CompareElements(container,focused.Get(),&same))&&same)return true;
  ComPtr<IUIAutomationElement> parent; if(FAILED(walker->GetParentElement(focused.Get(),&parent)))return false;
  focused=parent;
 }
 return false;
}
static bool waitForFocus(IUIAutomationElement *element,DWORD timeout,HWND window=target) {
 const auto deadline=GetTickCount64()+timeout;
 do {foreground(window);if(containsFocus(element))return true;Sleep(40);}while(GetTickCount64()<deadline);
 return false;
}
template<class Predicate> static void focusControl(Predicate match,const char *error,HWND window=target) {
 activate(window); auto element=unique(match,window);
 if(containsFocus(element.Get()))return;
 // SetFocus is asynchronous for Chromium. Some contenteditables require a click.
 element->SetFocus();
 if(waitForFocus(element.Get(),400,window))return;
 click(element.Get(),window);
 if(!waitForFocus(element.Get(),1600,window))throw std::runtime_error(error);
}
static void focusComposer() {focusControl(composer,"Codex draft focus could not be verified. Click the Codex message field, then retry the retained snip.");}
static void focusAnnotation() {
 HWND window=annotationWindow();auto active=GetForegroundWindow();if(active!=target&&active!=window){try{activate(target);}catch(const std::exception&){foreground(annotationWindow());}}
 window=annotationWindow();
 bool hasField=false;for(auto e:elements(window))hasField|=editor(e.Get());
 if(!hasField){auto reopen=unique([](auto e){return role(e)==UIA_ButtonControlTypeId&&name(e)==L"Focus unsaved browser comment";});click(reopen.Get());Sleep(100);window=annotationWindow();}
 auto field=unique(editor,window);field->SetFocus();
 // Chromium can move the editor from the main accessibility tree into its
 // owned popup during focus. Re-resolve the field instead of retaining that node.
 for(int attempt=0;attempt<3;attempt++){
  window=annotationWindow();foreground(window);field=unique(editor,window);
  if(containsFocus(field.Get()))return;
  if(attempt==1)click(field.Get(),window);
  Sleep(100);
 }
 throw std::runtime_error("Annotation comment focus could not be verified.");
}
static std::wstring clipboardText() { if(!OpenClipboard(nullptr))throw std::runtime_error("Clipboard is busy."); HANDLE h=GetClipboardData(CF_UNICODETEXT);auto p=h?(wchar_t*)GlobalLock(h):nullptr;std::wstring s=p?p:L"";if(p)GlobalUnlock(h);CloseClipboard();return s; }
int wmain(int argc,wchar_t **argv) {
 try {
  CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED); if(FAILED(CoCreateInstance(CLSID_CUIAutomation,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&automation))))throw std::runtime_error("Windows accessibility could not start.");
  if(argc<2)throw std::runtime_error("Missing Point operation."); std::wstring op=argv[1];
  if(op==L"identify") { EnumWindows(choose,0);if(!target)throw std::runtime_error("Open a Codex desktop chat, then retry your snip.");std::cout<<"{\"window\":\""<<(uintptr_t)target<<"\",\"pid\":"<<targetPid<<",\"version\":"<<quote(identity(targetPid))<<"}";return 0; }
  if(argc!=4)throw std::runtime_error("Invalid Point operation.");target=(HWND)(uintptr_t)std::stoull(argv[2]);targetPid=(DWORD)std::stoul(argv[3]);valid();
  if(op==L"observe") {
   int composers=0,editors=0,attachments=0,annotations=0,stages=0;
   bool permissionTitle=false,allow=false,block=false,pendingComment=false;
   for(auto e:elements()){composers+=composer(e.Get());editors+=editor(e.Get());stages+=stage(e.Get());auto s=name(e.Get());auto r=role(e.Get());if(r==UIA_ButtonControlTypeId&&(contains(s,L"Remove image")||contains(s,L"Remove attachment")||contains(s,L"Remove file")))attachments++;if(r==UIA_ButtonControlTypeId&&s==L"Remove annotations attachment")annotations+=draftAnnotationCount(e.Get());permissionTitle|=s==L"Let this site start annotation mode?"||s==L"Let this site toggle annotation mode?";allow|=r==UIA_ButtonControlTypeId&&s==L"Allow";block|=r==UIA_ButtonControlTypeId&&s==L"Block";pendingComment|=r==UIA_ButtonControlTypeId&&s==L"Focus unsaved browser comment";}

   HWND popup=annotationWindow();if(popup!=target){editors=0;for(auto e:elements(popup))editors+=editor(e.Get());}
   if(pendingComment)editors++;
   std::cout<<"{\"composer\":"<<(composers==1?"true":"false")<<",\"editor\":"<<(editors>0?"true":"false")<<",\"permission\":"<<(permissionTitle&&allow&&block?"true":"false")<<",\"attachments\":"<<attachments<<",\"annotations\":"<<annotations<<",\"stage\":"<<(stages==1?"true":"false")<<"}";return 0;
  }
  if(op==L"copy-link") {activate();chord({VK_CONTROL,VK_MENU,'L'});}
  else if(op==L"open-tab") {
   activate();chord({VK_CONTROL,'T'});chord({VK_CONTROL,'L'});
   bool ready=false;const auto deadline=GetTickCount64()+3000;
   do{foreground();ComPtr<IUIAutomationElement> e;automation->GetFocusedElement(&e);if(e&&address(e.Get())){ready=true;break;}Sleep(50);}while(GetTickCount64()<deadline);
   if(!ready)throw std::runtime_error("The browser address field is not focused. Your snip is retained.");
  }
  else if(op==L"navigate") {
   foreground(); auto text=clipboardText();if(!std::regex_match(text,std::wregex(L"http://127\\.0\\.0\\.1:[0-9]+/capture/[a-f0-9]{64}/")))throw std::runtime_error("Invalid Point page URL.");
   ComPtr<IUIAutomationElement> e;automation->GetFocusedElement(&e);if(!e||!address(e.Get()))throw std::runtime_error("The browser address field is not focused.");
   chord({VK_CONTROL,'A'});chord({VK_CONTROL,'V'});
   bool pasted=false;const auto deadline=GetTickCount64()+2500;
   do{foreground();ComPtr<IUIAutomationElement> field;automation->GetFocusedElement(&field);if(!field||!address(field.Get()))throw std::runtime_error("The browser address field lost focus.");ComPtr<IUIAutomationValuePattern> value;if(SUCCEEDED(field->GetCurrentPatternAs(UIA_ValuePatternId,IID_PPV_ARGS(&value)))){BSTR raw=nullptr;if(SUCCEEDED(value->get_CurrentValue(&raw))){pasted=std::wstring(raw?raw:L"")==text;SysFreeString(raw);}}if(pasted)break;Sleep(40);}while(GetTickCount64()<deadline);
   if(!pasted)throw std::runtime_error("The snip URL could not be verified in Codex’s address field.");
   chord({VK_RETURN});
  }
  else if(op==L"annotate") {activate();auto e=unique([](auto e){return role(e)==UIA_ButtonControlTypeId&&name(e)==L"Annotate this snip";});click(e.Get());}
  else if(op==L"stage") throw std::runtime_error("This Codex build saves annotations directly to the draft.");
  else if(op==L"focus-composer") focusComposer();
  else if(op==L"focus-annotation") focusAnnotation();
  else if(op==L"paste-image") {foreground();auto e=unique(composer);if(!containsFocus(e.Get()))throw std::runtime_error("The Codex composer lost focus.");if(!IsClipboardFormatAvailable(CF_DIB)&&!IsClipboardFormatAvailable(CF_DIBV5))throw std::runtime_error("Screenshot clipboard is unavailable.");chord({VK_CONTROL,VK_END});chord({VK_CONTROL,'V'});}
  else throw std::runtime_error("Unsupported Point operation.");
  std::cout<<"{\"ok\":true}";return 0;
 } catch(const std::exception &e) { std::string text=e.what();for(char &c:text)if(c=='"'||c=='\\'||c<' ')c=' ';std::cout<<"{\"error\":\""<<text<<"\"}";return 1; }
}
