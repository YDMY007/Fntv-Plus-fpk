// Package config —— Fntv-Plus 影视增强后端的运行时配置。
//
// 配置文件存于 TRIM_PKGETC（安装目录 etc），由后端读写；前端管理页通过
// /app/fntvplus/api/settings 读写同一份文件。所有配置均为「增强总开关」级别，
// 单用户 NAS 场景足够；多用户细粒度权限由 fnOS 桌面入口的 accessPerm 控制。
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Config 是后端的全部可持久化配置。
type Config struct {
	mu sync.RWMutex

	// EnhancementEnabled 增强总开关。false 时反代完全透传、不注入 payload（等价于原版影视）。
	EnhancementEnabled bool `json:"enhancement_enabled"`

	// Upstream 回环上游地址（飞牛影视网页服务）。为空时由启动参数/环境变量推导。
	Upstream string `json:"upstream"`

	// InjectCSS 是否额外注入内联 CSS（预留，当前 payload 自带样式，默认 false）。
	InjectCSS bool `json:"inject_css"`

	path string
}

// Default 返回出厂配置：增强默认开启。
func Default() *Config {
	return &Config{
		EnhancementEnabled: true,
		InjectCSS:           false,
	}
}

// Load 从 path 读取配置；文件不存在或解析失败时回退到 Default() 并写入默认文件。
func Load(path string) (*Config, error) {
	c := Default()
	c.path = path
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// 首次运行：把默认配置落盘，保证后续读取一致。
			_ = c.Save()
			return c, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, c); err != nil {
		return nil, err
	}
	c.path = path
	return c, nil
}

// Save 将当前配置写回磁盘（原子写：临时文件 + rename）。外部调用，内部加写锁。
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.save()
}

// save 实际落盘（调用者须已持有锁）。拆出来是为了让 Update 在持锁状态下调用而不重入死锁。
func (c *Config) save() error {
	if c.path == "" {
		return nil
	}
	if dir := filepath.Dir(c.path); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// Get 返回配置快照（线程安全）。
func (c *Config) Get() Config {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Config{
		EnhancementEnabled: c.EnhancementEnabled,
		Upstream:           c.Upstream,
		InjectCSS:          c.InjectCSS,
	}
}

// Update 用部分字段覆盖并落盘（线程安全）。仅覆盖显式传入的字段，避免清空未传字段。
// 注意：在持写锁状态下直接调无锁的 save()，避免 RWMutex 重入死锁。
func (c *Config) Update(patch map[string]any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := patch["enhancement_enabled"]; ok {
		if b, ok := v.(bool); ok {
			c.EnhancementEnabled = b
		}
	}
	if v, ok := patch["inject_css"]; ok {
		if b, ok := v.(bool); ok {
			c.InjectCSS = b
		}
	}
	if v, ok := patch["upstream"]; ok {
		if s, ok := v.(string); ok {
			c.Upstream = s
		}
	}
	return c.save()
}
