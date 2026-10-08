#import "DakMarkdownTextRun.h"
#import "DakMarkdownText.h"
#import "DakMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/DakMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/DakMarkdownTextSpec/Props.h>
#import <react/renderer/components/DakMarkdownTextSpec/RCTComponentViewHelpers.h>
#import <React/RCTFabricComponentsPlugins.h>
#import "Utils.h"

using namespace facebook::react;

@interface DakMarkdownTextRun () <RCTT3MarkdownTextRunViewProtocol>

@end

@implementation DakMarkdownTextRun {
  NSString * _text;
  NSString * _contextMenuConfig;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<DakMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const DakMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<DakMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<DakMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  if (newViewProps.contextMenuConfig != oldViewProps.contextMenuConfig) {
    _contextMenuConfig = [NSString stringWithUTF8String:newViewProps.contextMenuConfig.c_str()];
  }

  [super updateProps:props oldProps:oldProps];
}

- (BOOL)hasContextMenu
{
  return _contextMenuConfig.length > 0;
}

- (nullable UIMenu *)contextMenu
{
  if (_contextMenuConfig.length == 0) {
    return nil;
  }

  NSData *data = [_contextMenuConfig dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![config isKindOfClass:[NSDictionary class]]) {
    return nil;
  }

  NSArray *actionConfigs = config[@"actions"];
  if (![actionConfigs isKindOfClass:[NSArray class]] || actionConfigs.count == 0) {
    return nil;
  }

  NSMutableArray<UIMenuElement *> *actions = [NSMutableArray arrayWithCapacity:actionConfigs.count];
  __weak DakMarkdownTextRun *weakSelf = self;
  for (NSDictionary *actionConfig in actionConfigs) {
    if (![actionConfig isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSString *actionIdentifier = actionConfig[@"id"];
    NSString *title = actionConfig[@"title"];
    if (![actionIdentifier isKindOfClass:[NSString class]] ||
        ![title isKindOfClass:[NSString class]]) {
      continue;
    }

    UIAction *action = [UIAction actionWithTitle:title
                                           image:nil
                                      identifier:actionIdentifier
                                         handler:^(__kindof UIAction *selectedAction) {
      [weakSelf onContextMenuAction:selectedAction.identifier];
    }];
    if ([actionConfig[@"disabled"] boolValue]) {
      action.attributes = UIMenuElementAttributesDisabled;
    }
    [actions addObject:action];
  }

  if (actions.count == 0) {
    return nil;
  }
  NSString *title = [config[@"title"] isKindOfClass:[NSString class]] ? config[@"title"] : @"";
  return [UIMenu menuWithTitle:title children:actions];
}

- (void)onContextMenuAction:(NSString *)actionIdentifier
{
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::DakMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onContextMenuAction(facebook::react::DakMarkdownTextRunEventEmitter::OnContextMenuAction{
      static_cast<int>(self.tag),
      actionIdentifier.UTF8String,
    });
  }
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::DakMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::DakMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::DakMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::DakMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> DakMarkdownTextRunCls(void)
{
    return DakMarkdownTextRun.class;
}

@end
