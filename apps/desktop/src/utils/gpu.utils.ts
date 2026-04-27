import { invoke } from "@tauri-apps/api/core";
import { GpuInfo } from "../types/gpu.types";

let cachedDiscreteGpus: GpuInfo[] | null = null;
let loadingDiscreteGpus: Promise<GpuInfo[]> | null = null;

const filterUsableVulkanGpus = (gpu: GpuInfo) =>
  gpu.backend === "Vulkan" &&
  (gpu.deviceType === "DiscreteGpu" || gpu.deviceType === "IntegratedGpu");

export const loadDiscreteGpus = async (): Promise<GpuInfo[]> => {
  if (cachedDiscreteGpus) {
    return cachedDiscreteGpus;
  }

  if (!loadingDiscreteGpus) {
    loadingDiscreteGpus = invoke<GpuInfo[]>("list_gpus")
      .then((gpuList) => {
        const usable = gpuList.filter(filterUsableVulkanGpus);
        cachedDiscreteGpus = usable;
        return usable;
      })
      .catch((error) => {
        console.error("Failed to load GPU descriptors", error);
        cachedDiscreteGpus = [];
        return [];
      })
      .finally(() => {
        loadingDiscreteGpus = null;
      });
  }

  return loadingDiscreteGpus;
};
