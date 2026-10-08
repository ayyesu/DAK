#pragma once

#include <react/renderer/components/DakMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/DakMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char DakMarkdownTextComponentName[];

struct DakMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct DakMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float DakMarkdownTextAttachmentSize(const DakMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float DakMarkdownTextAttachmentBaselineOffset(
    const DakMarkdownTextAttachmentRange &) {
  return -2;
}

class DakMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<DakMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<DakMarkdownTextAttachmentRange> attachmentRanges;
};

class DakMarkdownTextShadowNode final : public ConcreteViewShadowNode<
DakMarkdownTextComponentName,
DakMarkdownTextProps,
DakMarkdownTextEventEmitter,
DakMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  DakMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<DakMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<DakMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
