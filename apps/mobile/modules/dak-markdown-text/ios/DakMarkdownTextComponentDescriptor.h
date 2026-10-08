#pragma once

#include "DakMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using DakMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<DakMarkdownTextShadowNode>;

void DakMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
