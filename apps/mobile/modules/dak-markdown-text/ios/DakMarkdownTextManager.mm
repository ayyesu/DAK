#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "Utils.h"

@interface DakMarkdownTextManager : RCTViewManager
@end

@implementation DakMarkdownTextManager

RCT_EXPORT_MODULE(DakMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface DakMarkdownTextRunManager : RCTViewManager
@end

@implementation DakMarkdownTextRunManager

RCT_EXPORT_MODULE(DakMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
