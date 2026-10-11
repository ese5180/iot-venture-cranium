#
# Cranium firmware: network-core image ("base function" domain).
#

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(cranium_netcore)

target_sources(app PRIVATE src/main.c)
