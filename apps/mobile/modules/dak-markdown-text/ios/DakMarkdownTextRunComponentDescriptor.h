#pragma once

#include "DakMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using DakMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<DakMarkdownTextRunShadowNode>;

void DakMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
