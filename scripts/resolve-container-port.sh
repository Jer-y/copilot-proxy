#!/bin/sh
set -eu

port=4399
expect_port=false

for argument do
  if [ "$expect_port" = true ]; then
    port=$argument
    expect_port=false
    continue
  fi

  case "$argument" in
    --)
      break
      ;;
    --port|-p)
      expect_port=true
      ;;
    --port=*)
      port=${argument#--port=}
      ;;
    -p=*)
      port=${argument#-p=}
      ;;
    --*)
      ;;
    -?*)
      # citty accepts clustered short options. Boolean start flags may precede
      # -p, while the remainder after another string option is its value.
      short_options=${argument#-}
      while [ -n "$short_options" ]; do
        option=${short_options%"${short_options#?}"}
        short_options=${short_options#?}
        case "$option" in
          p)
            if [ -n "$short_options" ]; then
              port=${short_options#=}
            else
              expect_port=true
            fi
            break
            ;;
          H|a|g|r)
            break
            ;;
          *)
            ;;
        esac
      done
      ;;
    *)
      ;;
  esac
done

printf '%s\n' "$port"
